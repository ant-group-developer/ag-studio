import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, PayloadTooLargeException, Post, Put, Query, Req,
  Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  deleteWorkspaceFile, getFileVersion, listFileVersions, listWorkspaceTree, normalizeRelPath, readWorkspaceBytes, readWorkspaceFile,
  StudioRunError, validateFileText, writeWorkspaceFile, type FileIssue, type FileVersionRow, type WorkspaceEntry, type WorkspaceFile,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

/** Largest file a person uploads into the workspace. */
export const WORKSPACE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Largest text a person saves from the editor. */
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

const WriteSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(MAX_TEXT_CHARS),
  /** sha256 of the copy the person edited; `null` = a new file (it must not exist yet). */
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
}).strict();
const RestoreSchema = z.object({ baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional() }).strict();
const UploadFormSchema = z.object({ dir: z.string().max(200).optional() });

interface UploadedTmp { path: string; originalname: string; size: number }

/** Multipart parsers may hand a UTF-8 file name over as Latin-1 ("Ghi chÃº"): read those bytes as UTF-8 again. */
function utf8Name(name: string): string {
  if (/[^\u0000-ÿ]/.test(name) || !/[\u0080-ÿ]/.test(name)) return name;
  const bytes = Buffer.from(name, 'latin1');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : name;
}

/** A file name a person gave, made safe for any disk: no folders, no reserved characters, at most 120 characters. */
export function safeFileName(name: string): string {
  const base = utf8Name(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();
  const out = cleaned.length > 120 ? cleaned.slice(cleaned.length - 120) : cleaned;
  if (!out || out === '.' || out === '..') throw new BadRequestException({ code: 'bad_name', message: 'Tên file không hợp lệ' });
  return out;
}

/**
 * The project's workspace as files (spec 2026-10-10 agent-workspace §3.1, §6): the tree, a file's text or bytes,
 * saving with a check against the copy the person saw (409 `file_conflict`), deleting, uploads, and every version.
 */
@Controller('projects/:projectId/files')
@UseGuards(RolesGuard)
export class FilesController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
  ) {}

  @Get()
  @Roles('viewer')
  tree(@Param('projectId') projectId: string, @Query('under') under?: string): Promise<{ entries: WorkspaceEntry[] }> {
    return mapErrors(() => ({ entries: listWorkspaceTree(this.workspace.dir(projectId), under ? { under } : {}) }));
  }

  /** The file, and what Studio's checks say of it (`issues`: errors Studio cannot use as is, warnings). */
  @Get('content')
  @Roles('viewer')
  content(@Param('projectId') projectId: string, @Query('path') path: string): Promise<WorkspaceFile & { issues: FileIssue[] }> {
    return mapErrors(() => {
      const file = readWorkspaceFile(this.workspace.dir(projectId), this.visible(path));
      return { ...file, issues: file.text === null ? [] : validateFileText(file.path, file.text) };
    });
  }

  /** The bytes as they are (images, PDFs, audio), for the web to show. */
  @Get('raw')
  @Roles('viewer')
  async raw(@Param('projectId') projectId: string, @Query('path') path: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await mapErrors(() => readWorkspaceBytes(this.workspace.dir(projectId), this.visible(path)));
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.bytes);
  }

  /** Body `{path, content, baseSha256?}`. 409 `file_conflict` (with `currentSha256`), 422 `read_only`. */
  @Put('content')
  @Roles('editor')
  write(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(() => {
      const body = parseBody(WriteSchema, raw);
      const saved = writeWorkspaceFile(this.engine.db, {
        projectId, dir: this.workspace.dir(projectId), path: body.path, content: body.content,
        ...(body.baseSha256 !== undefined ? { baseSha256: body.baseSha256 } : {}),
        author: { kind: 'user', id: req.authContext!.userId },
      });
      return { ...saved, issues: validateFileText(saved.path, body.content) };
    });
  }

  @Delete()
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('projectId') projectId: string, @Query('path') path: string, @Query('baseSha256') baseSha256: string | undefined, @Req() req: Request) {
    return mapErrors(() => deleteWorkspaceFile(this.engine.db, {
      projectId, dir: this.workspace.dir(projectId), path, ...(baseSha256 ? { baseSha256 } : {}),
      author: { kind: 'user', id: req.authContext!.userId },
    }));
  }

  /** Multipart `file` (+ `dir`, default `context/uploads`): saved under its own name, ` (2)`… when taken. */
  @Post('upload')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: WORKSPACE_UPLOAD_MAX_BYTES, files: 1 } }))
  async upload(@Param('projectId') projectId: string, @Body() raw: unknown, @UploadedFile() file: UploadedTmp | undefined, @Req() req: Request) {
    try {
      const form = parseBody(UploadFormSchema, raw);
      if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Chọn file' });
      if (file.size > WORKSPACE_UPLOAD_MAX_BYTES) {
        throw new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${WORKSPACE_UPLOAD_MAX_BYTES / 1024 / 1024} MB` });
      }
      const dir = this.workspace.dir(projectId);
      const folder = normalizeRelPath(form.dir ?? 'context/uploads');
      const path = this.freePath(dir, folder, safeFileName(file.originalname));
      return await mapErrors(() => writeWorkspaceFile(this.engine.db, {
        projectId, dir, path, content: readFileSync(file.path), baseSha256: null, author: { kind: 'user', id: req.authContext!.userId },
      }));
    } finally {
      if (file) rmSync(file.path, { force: true });
    }
  }

  @Get('versions')
  @Roles('viewer')
  versions(@Param('projectId') projectId: string, @Query('path') path: string): Promise<{ versions: FileVersionRow[] }> {
    return mapErrors(() => ({ versions: listFileVersions(this.engine.db, projectId, this.visible(path)) }));
  }

  @Get('versions/:versionId')
  @Roles('viewer')
  version(@Param('projectId') projectId: string, @Param('versionId') versionId: string) {
    return mapErrors(() => {
      const v = getFileVersion(this.engine.db, projectId, versionId);
      if (!v) throw new StudioRunError('not_found', `không có phiên bản ${versionId}`);
      this.visible(v.path);
      return v;
    });
  }

  /** Writes a version's text back as the current file (a new version by the person who restores). */
  @Post('versions/:versionId/restore')
  @Roles('editor')
  restore(@Param('projectId') projectId: string, @Param('versionId') versionId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(() => {
      const body = parseBody(RestoreSchema, raw);
      const v = getFileVersion(this.engine.db, projectId, versionId);
      if (!v) throw new StudioRunError('not_found', `không có phiên bản ${versionId}`);
      if (v.content === null) throw new StudioRunError('rejected', 'phiên bản này không giữ nội dung (file nhị phân, quá lớn hoặc đã xoá)', { code: 'no_content' });
      return writeWorkspaceFile(this.engine.db, {
        projectId, dir: this.workspace.dir(projectId), path: v.path, content: v.content,
        ...(body.baseSha256 !== undefined ? { baseSha256: body.baseSha256 } : {}),
        author: { kind: 'user', id: req.authContext!.userId },
      });
    });
  }

  /** A path a person may see (hidden folders answer 404, as if absent). */
  private visible(path: string): string {
    const rel = normalizeRelPath(path);
    if (/^(\.claude|\.git|\.trash)(\/|$)/.test(rel)) throw new StudioRunError('not_found', `không có file ${rel}`);
    return rel;
  }

  private freePath(dir: string, folder: string, name: string): string {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; n < 1000; n += 1) {
      const candidate = `${folder}/${n === 1 ? name : `${stem} (${n})${ext}`}`;
      if (!existsSync(join(dir, ...candidate.split('/')))) return candidate;
    }
    throw new StudioRunError('conflict', `quá nhiều file trùng tên ${name}`, { code: 'file_conflict' });
  }
}
