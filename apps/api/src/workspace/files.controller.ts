import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, PayloadTooLargeException, Post, Put, Query, Req,
  Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createReadStream, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AUDIO_FILE_EXTS, AUDIO_MAX_BYTES, deleteWorkspaceFile, getFileVersion, listFileVersions, listWorkspaceTree, normalizeRelPath, readWorkspaceFile,
  statWorkspaceFile, StudioRunError, validateFileText, versionDiff, writeWorkspaceFile, type FileIssue, type FileVersionRow, type VersionDiff, type WorkspaceEntry,
  type WorkspaceFile,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { FileLinkService } from './file-links';
import { dropRawUpload, RawUploadFields, takeRawUpload, type UploadedTmp } from './raw-uploads';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

/** Largest file a person uploads into the workspace. */
export const WORKSPACE_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Largest audio file a person uploads: as long as the music a project takes (a whole track). */
export const AUDIO_UPLOAD_MAX_BYTES = AUDIO_MAX_BYTES.music;

/** The size limit of an upload by its name: audio up to 300 MB, anything else 50 MB. */
export function uploadMaxBytes(name: string): number {
  const lower = name.toLowerCase();
  return (AUDIO_FILE_EXTS as readonly string[]).some((ext) => lower.endsWith(ext)) ? AUDIO_UPLOAD_MAX_BYTES : WORKSPACE_UPLOAD_MAX_BYTES;
}
/** Largest text a person saves from the editor. */
const MAX_TEXT_CHARS = 2 * 1024 * 1024;

const WriteSchema = z.object({
  path: z.string().min(1).max(300),
  content: z.string().max(MAX_TEXT_CHARS),
  /** sha256 of the copy the person edited; `null` = a new file (it must not exist yet). */
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
}).strict();
const RestoreSchema = z.object({ baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional() }).strict();
const UploadFormSchema = z.object({ dir: z.string().max(200).optional(), ...RawUploadFields });

/** A file for the Files tab is refused only when too large (413). */
export function checkFileUpload(name: string, size: number): void {
  const max = uploadMaxBytes(name);
  if (size > max) throw new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${max / 1024 / 1024} MB` });
}

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
    private readonly links: FileLinkService,
  ) {}

  @Get()
  @Roles('viewer')
  tree(@Param('projectId') projectId: string, @Query('under') under?: string): Promise<{ entries: WorkspaceEntry[] }> {
    return mapErrors(async () => ({ entries: listWorkspaceTree(await this.workspace.dir(projectId), under ? { under } : {}) }));
  }

  /**
   * The file, and what Studio's checks say of it (`issues`: errors Studio cannot use as is, warnings). A file that is
   * not text is told from its size alone (never read nor hashed: `sha256` null) and comes with `streamUrl`, a short
   * link (`GET files/stream`, 15 minutes, ranges) the browser plays, shows or saves it from.
   */
  @Get('content')
  @Roles('viewer')
  content(@Param('projectId') projectId: string, @Query('path') path: string, @Req() req: Request): Promise<WorkspaceFile & { issues: FileIssue[]; streamUrl: string | null }> {
    return mapErrors(async () => {
      const file = readWorkspaceFile(await this.workspace.dir(projectId), this.visible(path));
      return {
        ...file, issues: file.text === null ? [] : validateFileText(file.path, file.text),
        streamUrl: file.binary ? this.links.url(projectId, file.path, req.authContext!.userId) : null,
      };
    });
  }

  /** The bytes as they are (images, PDFs, audio), for the web to show: streamed from disk, never held whole. */
  @Get('raw')
  @Roles('viewer')
  async raw(@Param('projectId') projectId: string, @Query('path') path: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await mapErrors(async () => statWorkspaceFile(await this.workspace.dir(projectId), this.visible(path)));
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(createReadStream(file.abs));
  }

  /** Body `{path, content, baseSha256?}`. 409 `file_conflict` (with `currentSha256`), 422 `read_only`. */
  @Put('content')
  @Roles('editor')
  write(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(async () => {
      const body = parseBody(WriteSchema, raw);
      const saved = await writeWorkspaceFile(this.engine.db, {
        projectId, dir: await this.workspace.dir(projectId), path: body.path, content: body.content,
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
    return mapErrors(async () => deleteWorkspaceFile(this.engine.db, {
      projectId, dir: await this.workspace.dir(projectId), path, ...(baseSha256 ? { baseSha256 } : {}),
      author: { kind: 'user', id: req.authContext!.userId },
    }));
  }

  /**
   * Multipart `file`, or `{uploadKey, name}` once the browser put the file on the bucket (`POST projects/:id/uploads`
   * with `purpose: "file"`); `dir` defaults to `context/uploads`. Saved under its own name, ` (2)`… when taken. Audio
   * ≤ 300 MB, else ≤ 50 MB.
   */
  @Post('upload')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: Math.max(WORKSPACE_UPLOAD_MAX_BYTES, AUDIO_UPLOAD_MAX_BYTES), files: 1 } }))
  async upload(@Param('projectId') projectId: string, @Body() raw: unknown, @UploadedFile() sent: UploadedTmp | undefined, @Req() req: Request) {
    let file = sent;
    let form: z.infer<typeof UploadFormSchema> | null = null;
    try {
      form = parseBody(UploadFormSchema, raw);
      if (!file && form.uploadKey) {
        if (!form.name) throw new BadRequestException({ code: 'name_missing', message: 'Thiếu tên file' });
        file = await takeRawUpload(this.engine.bucket, projectId, form.uploadKey, form.name, uploadMaxBytes);
      }
      if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Chọn file' });
      checkFileUpload(file.originalname, file.size);
      const dir = await this.workspace.dir(projectId);
      const folder = normalizeRelPath(form.dir ?? 'context/uploads');
      const path = this.freePath(dir, folder, safeFileName(file.originalname));
      const at = file;
      return await mapErrors(() => writeWorkspaceFile(this.engine.db, {
        projectId, dir, path, content: readFileSync(at.path), baseSha256: null, author: { kind: 'user', id: req.authContext!.userId },
      }));
    } finally {
      if (file) rmSync(file.path, { force: true });
      await dropRawUpload(this.engine.bucket, projectId, form?.uploadKey);
    }
  }

  @Get('versions')
  @Roles('viewer')
  versions(@Param('projectId') projectId: string, @Query('path') path: string): Promise<{ versions: FileVersionRow[] }> {
    return mapErrors(async () => ({ versions: await listFileVersions(this.engine.db, projectId, this.visible(path)) }));
  }

  @Get('versions/:versionId')
  @Roles('viewer')
  version(@Param('projectId') projectId: string, @Param('versionId') versionId: string) {
    return mapErrors(async () => {
      const v = await getFileVersion(this.engine.db, projectId, versionId);
      if (!v) throw new StudioRunError('not_found', `không có phiên bản ${versionId}`);
      this.visible(v.path);
      return v;
    });
  }

  /**
   * What a version changed: against `base` (another version of the same file, e.g. the one before a turn; `none` = an
   * empty file) or the version just before it. Hunks with 3 lines of context, or `unavailable: binary | too_large`.
   */
  @Get('versions/:versionId/diff')
  @Roles('viewer')
  diff(@Param('projectId') projectId: string, @Param('versionId') versionId: string, @Query('base') base?: string): Promise<VersionDiff> {
    return mapErrors(async () => {
      const d = await versionDiff(this.engine.db, projectId, versionId, base === 'none' ? { base: null } : base ? { base } : {});
      this.visible(d.path);
      return d;
    });
  }

  /** Writes a version's text back as the current file (a new version by the person who restores). */
  @Post('versions/:versionId/restore')
  @Roles('editor')
  restore(@Param('projectId') projectId: string, @Param('versionId') versionId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(async () => {
      const body = parseBody(RestoreSchema, raw);
      const v = await getFileVersion(this.engine.db, projectId, versionId);
      if (!v) throw new StudioRunError('not_found', `không có phiên bản ${versionId}`);
      if (v.content === null) throw new StudioRunError('rejected', 'phiên bản này không giữ nội dung (file nhị phân, quá lớn hoặc đã xoá)', { code: 'no_content' });
      return writeWorkspaceFile(this.engine.db, {
        projectId, dir: await this.workspace.dir(projectId), path: v.path, content: v.content,
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
