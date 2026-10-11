import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, PayloadTooLargeException, Post, Query, Req, UnsupportedMediaTypeException,
  UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  addSource, assetState, getSource, jobView, listJobs, listSources, projectActAs, queuePrepare, removeSource, requestJobCancel, requireJob,
  requireProject, requireVideo, sourceItems, StudioRunError, writeVideoIndex, writeWorkspaceFile, type ActorRole, type JobView, type SourceItem,
  type SourceMediaType,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { safeFileName, WORKSPACE_UPLOAD_MAX_BYTES } from './files.controller';
import { ProjectFootageService } from './project-footage.service';
import { SiteNameService } from '../ag-go/site-name.service';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

const ASSET_OR_PROJECT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AddSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ag_go_project'), ref: z.string().regex(ASSET_OR_PROJECT_ID), label: z.string().trim().min(1).max(200) }).strict(),
  z.object({
    kind: z.literal('ag_go_asset'), ref: z.string().regex(ASSET_OR_PROJECT_ID), label: z.string().trim().min(1).max(200),
    videoId: z.string().min(1).optional(),
    meta: z.object({ durationMs: z.number().nonnegative().optional(), thumbnailUrl: z.string().max(2000).optional(), agGoProjectId: z.string().max(80).optional() }).strict().optional(),
    /** Prepare it right away (a background job). */
    prepare: z.boolean().optional(),
  }).strict(),
]);
const PrepareSchema = z.object({ assetIds: z.array(z.string().regex(ASSET_OR_PROJECT_ID)).min(1).max(40), again: z.boolean().optional() }).strict();
const UploadFormSchema = z.object({ videoId: z.string().min(1).optional() });

/** What an uploaded file is, by its extension, and the folder it goes to. */
const UPLOAD_KINDS: { exts: string[]; mediaType: SourceMediaType; dir: string }[] = [
  { exts: ['.md', '.txt', '.pdf', '.csv', '.json', '.srt', '.vtt'], mediaType: 'document', dir: 'context/uploads' },
  { exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif'], mediaType: 'image', dir: 'context/images' },
  { exts: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'], mediaType: 'audio', dir: 'context/audio' },
];

interface UploadedTmp { path: string; originalname: string; size: number }

/** The person's role in the team as a job records it (a Studio admin acts as owner). */
function roleOf(engine: EngineService, req: Request, teamId: string): ActorRole {
  if (req.authContext?.isAdmin) return 'owner';
  return engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, req.authContext!.userId])?.role ?? 'viewer';
}

/**
 * The Inputs tab of a project (spec 2026-10-10 agent-workspace §4–§5): the ag-go projects and videos people picked,
 * files they upload into `context/`, searching the picked ag-go projects (as the person, who sees only their own
 * scope), preparing ag-go videos, and the project's background jobs with Stop.
 */
@Controller('projects/:projectId')
@UseGuards(RolesGuard)
export class InputsController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly footage: ProjectFootageService,
    private readonly siteName: SiteNameService,
  ) {}

  @Get('sources')
  @Roles('viewer')
  sources(@Param('projectId') projectId: string, @Query('videoId') videoId?: string): Promise<{ sources: SourceItem[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      return { sources: sourceItems(this.engine.db, projectId, videoId ? { videoId } : {}) };
    });
  }

  /**
   * Adds an ag-go project (its videos become searchable for the agent) or an ag-go video (to the project, or to one
   * video). ag-go is asked as the project's owner, whom the agent and renders act as: what they cannot use is refused
   * (422 `owner_cannot_access`).
   */
  @Post('sources')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  add(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<{ source: SourceItem; prepare?: unknown }> {
    return mapErrors(async () => {
      const body = parseBody(AddSchema, raw);
      const project = requireProject(this.engine.db, projectId);
      const owner = projectActAs(this.engine.db, projectId);
      if (!owner) throw new StudioRunError('invalid', `dự án chưa có chủ để hỏi ${this.siteName.current()}`, { code: 'no_owner' });
      const userId = req.authContext!.userId;
      if (body.kind === 'ag_go_project') {
        const seen = await this.footage.search(owner, { projectIds: [body.ref], limit: 1 });
        if (seen.total === 0 && seen.items.length === 0) {
          throw new StudioRunError('invalid', `Chủ dự án không thấy video đã phân tích nào trong project ${this.siteName.current()} này`, { code: 'owner_cannot_access' });
        }
        const s = addSource(this.engine.db, { projectId, kind: 'ag_go_project', ref: body.ref, mediaType: 'mixed', label: body.label, meta: { videos: seen.total }, addedBy: userId });
        return { source: this.item(projectId, s.id) };
      }
      if (body.videoId) {
        const v = requireVideo(this.engine.db, body.videoId);
        if (v.project_id !== projectId) throw new StudioRunError('invalid', 'video thuộc dự án khác', { code: 'other_project' });
      }
      const { missing } = await this.footage.check(owner, [body.ref]);
      if (missing.length) {
        throw new StudioRunError('invalid', `Chủ dự án không dùng được video này trên ${this.siteName.current()} (không có quyền hoặc chưa có bản xem)`, { code: 'owner_cannot_access' });
      }
      const s = addSource(this.engine.db, {
        projectId, videoId: body.videoId ?? null, kind: 'ag_go_asset', ref: body.ref, mediaType: 'video', label: body.label, meta: body.meta ?? {}, addedBy: userId,
      });
      if (body.videoId) writeVideoIndex(this.engine.db, this.workspace.dir(projectId), projectId, body.videoId);
      const prepare = body.prepare
        ? queuePrepare(this.engine.db, {
          projectId, assetIds: [body.ref], threadId: this.videoThreadId(body.videoId), createdBy: userId, actorRole: roleOf(this.engine, req, project.team_id),
        }, new Date().toISOString())[body.ref]
        : undefined;
      return { source: this.item(projectId, s.id), ...(prepare ? { prepare } : {}) };
    });
  }

  @Delete('sources/:sourceId')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('projectId') projectId: string, @Param('sourceId') sourceId: string): Promise<void> {
    await mapErrors(() => {
      const s = getSource(this.engine.db, sourceId);
      if (!s || s.project_id !== projectId) throw new StudioRunError('not_found', `không có nguồn ${sourceId}`);
      removeSource(this.engine.db, sourceId);
      if (s.kind === 'ag_go_asset' && s.video_id) writeVideoIndex(this.engine.db, this.workspace.dir(projectId), projectId, s.video_id);
    });
  }

  /**
   * A document, image or audio file into `context/` (videos come from ag-go): saved under its own name and listed as
   * a source. Word files are refused (save them as PDF).
   */
  @Post('sources/upload')
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
      const name = safeFileName(file.originalname);
      const ext = extname(name).toLowerCase();
      if (ext === '.docx' || ext === '.doc') throw new UnsupportedMediaTypeException({ code: 'docx_not_supported', message: 'Chưa đọc được file Word: lưu thành PDF rồi tải lên' });
      if (['.mp4', '.mov', '.mkv', '.avi', '.webm'].includes(ext)) {
        throw new UnsupportedMediaTypeException({ code: 'video_from_ag_go', message: `Video lấy từ ${this.siteName.current()}: tải lên ${this.siteName.current()} rồi chọn ở đây` });
      }
      const kind = UPLOAD_KINDS.find((k) => k.exts.includes(ext));
      if (!kind) throw new UnsupportedMediaTypeException({ code: 'file_type', message: `Chưa nhận loại file ${ext || '(không đuôi)'}` });
      return await mapErrors(() => {
        requireProject(this.engine.db, projectId);
        if (form.videoId) {
          const v = requireVideo(this.engine.db, form.videoId);
          if (v.project_id !== projectId) throw new StudioRunError('invalid', 'video thuộc dự án khác', { code: 'other_project' });
        }
        const dir = this.workspace.dir(projectId);
        const path = this.freePath(dir, kind.dir, name);
        const saved = writeWorkspaceFile(this.engine.db, {
          projectId, dir, path, content: readFileSync(file.path), baseSha256: null, author: { kind: 'user', id: req.authContext!.userId },
        });
        const s = addSource(this.engine.db, {
          projectId, videoId: form.videoId ?? null, kind: 'upload', ref: saved.path, mediaType: kind.mediaType, label: name, meta: { bytes: file.size }, addedBy: req.authContext!.userId,
        });
        return { source: this.item(projectId, s.id), file: saved };
      });
    } finally {
      if (file) rmSync(file.path, { force: true });
    }
  }

  /** Videos of the project's ag-go projects the person can see (their own ag-go scope), with where each stands here. */
  @Get('footage')
  @Roles('viewer')
  footageSearch(
    @Param('projectId') projectId: string, @Req() req: Request,
    @Query('agGoProjectId') agGoProjectId?: string, @Query('q') q?: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string,
  ) {
    return mapErrors(async () => {
      requireProject(this.engine.db, projectId);
      const picked = listSources(this.engine.db, projectId).filter((s) => s.kind === 'ag_go_project').map((s) => s.ref);
      if (agGoProjectId && !picked.includes(agGoProjectId)) throw new StudioRunError('invalid', `project ${this.siteName.current()} này chưa thuộc đầu vào của dự án`, { code: 'not_an_input' });
      if (!picked.length) return { items: [], nextCursor: null, total: 0 };
      const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
      const r = await this.footage.search(req.authContext!.userId, {
        projectIds: agGoProjectId ? [agGoProjectId] : picked, ...(q?.trim() ? { q: q.trim() } : {}), limit: n, ...(cursor ? { cursor } : {}),
      });
      return { ...r, items: r.items.map((i) => ({ ...i, prepared: assetState(this.engine.db, projectId, i.assetId) })) };
    });
  }

  /** Prepares ag-go videos of the project (background jobs; the video's thread is told when each ends). */
  @Post('prepare')
  @Roles('editor')
  prepare(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(() => {
      const body = parseBody(PrepareSchema, raw);
      const project = requireProject(this.engine.db, projectId);
      const first = listSources(this.engine.db, projectId).find((s) => s.kind === 'ag_go_asset' && body.assetIds.includes(s.ref) && s.video_id);
      return {
        assets: queuePrepare(this.engine.db, {
          projectId, assetIds: body.assetIds, threadId: this.videoThreadId(first?.video_id ?? undefined), createdBy: req.authContext!.userId,
          actorRole: roleOf(this.engine, req, project.team_id), ...(body.again ? { again: true } : {}),
        }, new Date().toISOString()),
      };
    });
  }

  @Get('jobs')
  @Roles('viewer')
  jobs(@Param('projectId') projectId: string, @Query('active') active?: string, @Query('videoId') videoId?: string): Promise<{ jobs: JobView[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      return { jobs: listJobs(this.engine.db, projectId, { ...(active === '1' ? { active: true } : {}), ...(videoId ? { videoId } : {}), limit: 50 }).map(jobView) };
    });
  }

  /** Stop: a job in line is cancelled at once; a running one stops within seconds (its ffmpeg killed, its farm job cancelled). */
  @Post('jobs/:jobId/cancel')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('projectId') projectId: string, @Param('jobId') jobId: string): Promise<JobView> {
    return mapErrors(() => {
      const j = requireJob(this.engine.db, jobId);
      if (j.project_id !== projectId) throw new StudioRunError('not_found', `không có việc ${jobId}`);
      return jobView(requestJobCancel(this.engine.db, jobId));
    });
  }

  private item(projectId: string, sourceId: string): SourceItem {
    return sourceItems(this.engine.db, projectId).find((s) => s.id === sourceId)!;
  }

  /** The main thread of a video (told when its jobs end); none for project-wide work. */
  private videoThreadId(videoId: string | undefined): string | null {
    if (!videoId) return null;
    return this.engine.db.get<{ id: string }>("SELECT id FROM agent_threads WHERE video_id = ? AND kind = 'video' AND archived_at IS NULL", [videoId])?.id ?? null;
  }

  private freePath(dir: string, folder: string, name: string): string {
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let n = 1; ; n += 1) {
      const rel = `${folder}/${n === 1 ? name : `${stem} (${n})${ext}`}`;
      if (!existsSync(join(dir, ...rel.split('/')))) return rel;
    }
  }
}
