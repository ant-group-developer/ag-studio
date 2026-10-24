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
  addSource, agGoProjectIds, assetCounts, assetStates, AUDIO_FILE_EXTS, getSource, jobView, listJobs, listSources, nameUnnamedAssets, queuePrepare, removeSource, requestJobCancel, requireJob,
  PROJECT_AUDIO_DIR, REFERENCE_UPLOAD_DIR, REFERENCE_UPLOAD_MAX_BYTES, REFERENCE_VIDEO_EXTS, requireProject, requireVideo, sourceItems, StudioRunError, writeVideoIndex,
  writeWorkspaceFile, type ActorRole, type AssetCounts, type JobView, type SourceItem, type SourceMediaType, unnamedAssetIds,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { checkFileUpload, safeFileName, uploadMaxBytes, WORKSPACE_UPLOAD_MAX_BYTES } from './files.controller';
import { dropRawUpload, RawUploadFields, signRawUpload, SignUploadFields, takeRawUpload, type UploadedTmp } from './raw-uploads';
import { addability, ProjectFootageService, type AgGoAddability } from './project-footage.service';
import { SiteNameService } from '../ag-go/site-name.service';
import { FOOTAGE_RESOLUTIONS, FOOTAGE_SORT_FIELDS, FOOTAGE_USABILITIES } from '../ag-go/client';
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
const AccessSchema = z.object({ projectIds: z.array(z.string().regex(ASSET_OR_PROJECT_ID)).min(1).max(200) }).strict();
const UploadFormSchema = z.object({
  videoId: z.string().min(1).optional(),
  /** A reference video to learn an edit style from (not footage): saved under `context/references/`, up to 300 MB. */
  reference: z.union([z.enum(['1', 'true']), z.literal(true)]).optional(),
  ...RawUploadFields,
});
const SignUploadSchema = z.object({ purpose: z.enum(['source', 'reference', 'file']), ...SignUploadFields }).strict();

/** A comma-separated list in a query string (or the same key repeated). */
const csv = <T extends z.ZodTypeAny>(item: T) => z.union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(item).max(50));
const id = z.string().regex(ASSET_OR_PROJECT_ID);
const label = z.string().min(1).max(100);
const int = z.coerce.number().int().min(0);
/** The video picker's query: ag-go's footage filters, sort and paging, plus which picked ag-go projects to look in. */
const FootageQuerySchema = z.object({
  agGoProjectId: id.optional(),
  agGoProjectIds: csv(id).optional(),
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  categoryIds: csv(id).optional(),
  ownerUserIds: csv(label).optional(),
  provinceIds: csv(id).optional(),
  resolutions: csv(z.enum(FOOTAGE_RESOLUTIONS)).optional(),
  tags: csv(label).optional(),
  genres: csv(label).optional(),
  timesOfDay: csv(label).optional(),
  orientations: csv(label).optional(),
  minDurationMs: int.optional(),
  maxDurationMs: int.optional(),
  usability: z.enum(FOOTAGE_USABILITIES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(FOOTAGE_SORT_FIELDS).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
}).strict();

/** What an uploaded file is, by its extension, and the folder it goes to. */
const UPLOAD_KINDS: { exts: string[]; mediaType: SourceMediaType; dir: string }[] = [
  { exts: ['.md', '.txt', '.pdf', '.csv', '.json', '.srt', '.vtt'], mediaType: 'document', dir: 'context/uploads' },
  { exts: ['.jpg', '.jpeg', '.png', '.webp', '.gif'], mediaType: 'image', dir: 'context/images' },
  { exts: [...AUDIO_FILE_EXTS], mediaType: 'audio', dir: PROJECT_AUDIO_DIR },
];

/** The person's role in the team as a job records it (a Studio admin acts as owner). */
async function roleOf(engine: EngineService, req: Request, teamId: string): Promise<ActorRole> {
  if (req.authContext?.isAdmin) return 'owner';
  return (await engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, req.authContext!.userId]))?.role ?? 'viewer';
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

  /** When names were last looked up for a project's unnamed videos: once every 10 minutes at most. */
  private readonly namedAt = new Map<string, number>();

  /**
   * The sources (with `videoId`: the project's own and that video's) with where each ag-go video stands, in one pass,
   * and how many distinct ag-go videos are ready, being prepared, failed or not prepared yet.
   */
  @Get('sources')
  @Roles('viewer')
  sources(@Param('projectId') projectId: string, @Query('videoId') videoId?: string): Promise<{ sources: SourceItem[]; counts: AssetCounts }> {
    return mapErrors(async () => {
      await requireProject(this.engine.db, projectId);
      const sources = await sourceItems(this.engine.db, projectId, videoId ? { videoId } : {});
      await this.nameUnnamed(projectId);
      return { sources, counts: assetCounts(sources) };
    });
  }

  /**
   * ag-go videos added without a name (the agent left it out, so people saw the asset id) get their names from the
   * picked ag-go projects: in the background, best effort, so the next load shows them.
   */
  private async nameUnnamed(projectId: string): Promise<void> {
    const db = this.engine.db;
    const missing = new Set(await unnamedAssetIds(db, projectId));
    if (!missing.size || Date.now() - (this.namedAt.get(projectId) ?? 0) < 10 * 60_000) return;
    this.namedAt.set(projectId, Date.now());
    const projectIds = await agGoProjectIds(db, projectId);
    if (!projectIds.length) return;
    this.naming = (async () => {
      const names = new Map<string, string>();
      let cursor: string | undefined;
      for (let page = 0; page < 20 && names.size < missing.size; page++) {
        const r = await this.footage.search({ projectIds, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const i of r.items) if (missing.has(i.assetId) && i.name) names.set(i.assetId, i.name);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      if (names.size) await nameUnnamedAssets(db, await this.workspace.dir(projectId), projectId, names);
    })().catch(() => { /* looked up again in 10 minutes */ });
  }

  /** The last lookup of names (tests wait for it). */
  naming: Promise<void> = Promise.resolve();

  /**
   * Adds an ag-go project (its videos become searchable for the agent) or an ag-go video (to the project, or to one
   * video). A project is added only by someone who may download its originals on ag-go and when it has a usable
   * analysed video (asked as that person; 422 `ag_go_not_visible` / `ag_go_view_only` / `ag_go_no_videos`); the project
   * then uses it with no further check, whoever works on it (plan 2026-10-24). A video must belong to an ag-go project
   * added already (422 `no_ag_go_project`, `not_in_added_project`).
   */
  @Post('sources')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  add(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<{ source: SourceItem; prepare?: unknown }> {
    return mapErrors(async () => {
      const body = parseBody(AddSchema, raw);
      const project = await requireProject(this.engine.db, projectId);
      const userId = req.authContext!.userId;
      if (body.kind === 'ag_go_project') {
        const access = (await this.footage.access(userId, [body.ref])).get(body.ref);
        const state = addability(access);
        if (state !== 'addable') throw this.cannotAdd(state);
        const s = await addSource(this.engine.db, {
          projectId, kind: 'ag_go_project', ref: body.ref, mediaType: 'mixed', label: body.label, meta: { videos: access!.usableVideos }, addedBy: userId,
        });
        return { source: await this.item(projectId, s.id) };
      }
      if (body.videoId) {
        const v = await requireVideo(this.engine.db, body.videoId);
        if (v.project_id !== projectId) throw new StudioRunError('invalid', 'video thuộc dự án khác', { code: 'other_project' });
      }
      const site = this.siteName.current();
      const projects = await agGoProjectIds(this.engine.db, projectId);
      if (!projects.length) throw new StudioRunError('invalid', `Thêm project ${site} chứa video này vào dự án trước`, { code: 'no_ag_go_project' });
      const { missing } = await this.footage.check(projects, [body.ref]);
      if (missing.length) {
        throw new StudioRunError('invalid', `Video này không thuộc project ${site} nào của dự án: thêm project chứa nó trước`, { code: 'not_in_added_project' });
      }
      const s = await addSource(this.engine.db, {
        projectId, videoId: body.videoId ?? null, kind: 'ag_go_asset', ref: body.ref, mediaType: 'video', label: body.label, meta: body.meta ?? {}, addedBy: userId,
      });
      if (body.videoId) await writeVideoIndex(this.engine.db, await this.workspace.dir(projectId), projectId, body.videoId);
      const prepare = body.prepare
        ? (await queuePrepare(this.engine.db, {
          projectId, assetIds: [body.ref], threadId: await this.videoThreadId(body.videoId), createdBy: userId, actorRole: await roleOf(this.engine, req, project.team_id),
        }, new Date().toISOString()))[body.ref]
        : undefined;
      return { source: await this.item(projectId, s.id), ...(prepare ? { prepare } : {}) };
    });
  }

  /**
   * Whether the person may add each of these ag-go projects (the picker's cards), asked as that person: `addable`,
   * `view_only` (watermarked only), `no_videos` (no usable analysed video), `not_visible`; with the analysed and usable
   * videos of those they see.
   */
  @Post('ag-go-access')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  agGoAccess(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<{ items: { projectId: string; state: AgGoAddability; analyzedVideos: number; usableVideos: number }[] }> {
    return mapErrors(async () => {
      const body = parseBody(AccessSchema, raw);
      await requireProject(this.engine.db, projectId);
      const ids = [...new Set(body.projectIds)];
      const access = await this.footage.access(req.authContext!.userId, ids);
      return {
        items: ids.map((id) => {
          const a = access.get(id);
          return { projectId: id, state: addability(a), analyzedVideos: a?.analyzedVideos ?? 0, usableVideos: a?.usableVideos ?? 0 };
        }),
      };
    });
  }

  /**
   * Removes a source. An ag-go project whose videos are still used (added to the project or to a video) and are in no
   * other ag-go project of it is refused first (409 `project_in_use`, with how many and in which videos): with
   * `force=1` it is removed anyway, and ag-go no longer serves those videos to the project.
   */
  @Delete('sources/:sourceId')
  @Roles('editor')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('projectId') projectId: string, @Param('sourceId') sourceId: string, @Query('force') force: string | undefined, @Req() req: Request): Promise<void> {
    await mapErrors(async () => {
      const s = await getSource(this.engine.db, sourceId);
      if (!s || s.project_id !== projectId) throw new StudioRunError('not_found', `không có nguồn ${sourceId}`);
      if (s.kind === 'ag_go_project' && force !== '1') await this.refuseInUse(projectId, s.ref);
      await removeSource(this.engine.db, sourceId, req.authContext!.userId);
      if (s.kind === 'ag_go_asset' && s.video_id) await writeVideoIndex(this.engine.db, await this.workspace.dir(projectId), projectId, s.video_id);
    });
  }

  /**
   * A link to put one file straight on the bucket, checked first as its upload will be (`source`, `reference`: the
   * Inputs tab; `file`: the Files tab): `{key, url, contentType, expiresAt}`. The browser PUTs the file there with that
   * `Content-Type`, then calls `sources/upload` or `files/upload` with `{uploadKey: key, name}`.
   */
  @Post('uploads')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  async signUpload(@Param('projectId') projectId: string, @Body() raw: unknown) {
    const body = parseBody(SignUploadSchema, raw);
    if (body.purpose === 'file') checkFileUpload(body.name, body.size);
    else this.checkSource(body.name, body.size, body.purpose === 'reference');
    await mapErrors(() => requireProject(this.engine.db, projectId));
    return signRawUpload(this.engine.bucket, projectId, body.contentType);
  }

  /**
   * A document, image or audio file into `context/` (videos come from ag-go), or, with `reference`, a reference video
   * to learn an edit style from (`context/references/`, never footage): saved under its own name and listed as a
   * source. Word files are refused (save them as PDF). Audio up to 300 MB (a whole music track), other files 50 MB.
   * Multipart `file`, or `{uploadKey, name}` once the browser put the file on the bucket (`uploads`).
   */
  @Post('sources/upload')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: Math.max(WORKSPACE_UPLOAD_MAX_BYTES, REFERENCE_UPLOAD_MAX_BYTES), files: 1 } }))
  async upload(@Param('projectId') projectId: string, @Body() raw: unknown, @UploadedFile() sent: UploadedTmp | undefined, @Req() req: Request) {
    let file = sent;
    let form: z.infer<typeof UploadFormSchema> | null = null;
    try {
      form = parseBody(UploadFormSchema, raw);
      const reference = !!form.reference;
      if (!file && form.uploadKey) {
        if (!form.name) throw new BadRequestException({ code: 'name_missing', message: 'Thiếu tên file' });
        file = await takeRawUpload(this.engine.bucket, projectId, form.uploadKey, form.name, (n) => (reference ? REFERENCE_UPLOAD_MAX_BYTES : uploadMaxBytes(n)));
      }
      if (!file) throw new BadRequestException({ code: 'file_missing', message: 'Chọn file' });
      const { name, kind } = this.checkSource(file.originalname, file.size, reference);
      const at = file;
      const f = form;
      return await mapErrors(async () => {
        await requireProject(this.engine.db, projectId);
        if (f.videoId) {
          const v = await requireVideo(this.engine.db, f.videoId);
          if (v.project_id !== projectId) throw new StudioRunError('invalid', 'video thuộc dự án khác', { code: 'other_project' });
        }
        const dir = await this.workspace.dir(projectId);
        const path = this.freePath(dir, kind.dir, name);
        const saved = await writeWorkspaceFile(this.engine.db, {
          projectId, dir, path, content: readFileSync(at.path), baseSha256: null, author: { kind: 'user', id: req.authContext!.userId },
        });
        const s = await addSource(this.engine.db, {
          projectId, videoId: f.videoId ?? null, kind: 'upload', ref: saved.path, mediaType: kind.mediaType, label: name,
          meta: { bytes: at.size, ...(reference ? { reference: true } : {}) }, addedBy: req.authContext!.userId,
        });
        return { source: await this.item(projectId, s.id), file: saved };
      });
    } finally {
      if (file) rmSync(file.path, { force: true });
      await dropRawUpload(this.engine.bucket, projectId, form?.uploadKey);
    }
  }

  /**
   * The name an upload is saved under and where it goes, or why it is refused (by its name, size and whether it is a
   * reference video): too large (413), Word, a video that is not a reference (it comes from ag-go), an unknown type.
   */
  private checkSource(rawName: string, size: number, reference: boolean): { name: string; kind: { mediaType: SourceMediaType; dir: string } } {
    const name = safeFileName(rawName);
    const ext = extname(name).toLowerCase();
    const isVideo = (REFERENCE_VIDEO_EXTS as readonly string[]).includes(ext);
    const max = reference ? REFERENCE_UPLOAD_MAX_BYTES : uploadMaxBytes(name);
    if (size > max) {
      throw new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${max / 1024 / 1024} MB` });
    }
    if (ext === '.docx' || ext === '.doc') throw new UnsupportedMediaTypeException({ code: 'docx_not_supported', message: 'Chưa đọc được file Word: lưu thành PDF rồi tải lên' });
    if (reference && !isVideo) {
      throw new UnsupportedMediaTypeException({ code: 'not_video', message: `Video mẫu phải là file video (${REFERENCE_VIDEO_EXTS.join(', ')})` });
    }
    if (isVideo && !reference) {
      throw new UnsupportedMediaTypeException({
        code: 'video_from_ag_go',
        message: `Video lấy từ ${this.siteName.current()}: tải lên ${this.siteName.current()} rồi chọn ở đây. Video mẫu để học phong cách dựng thì tải ở mục Video mẫu`,
      });
    }
    const kind = reference ? { mediaType: 'video' as const, dir: REFERENCE_UPLOAD_DIR } : UPLOAD_KINDS.find((k) => k.exts.includes(ext));
    if (!kind) throw new UnsupportedMediaTypeException({ code: 'file_type', message: `Chưa nhận loại file ${ext || '(không đuôi)'}` });
    return { name, kind };
  }

  /**
   * Videos of the project's ag-go projects (ag-go's trusted mode: every one of them, whoever asks), with where each
   * stands here: the filters, sort and paging of ag-go's footage search, always within the projects picked for this project.
   */
  @Get('footage')
  @Roles('viewer')
  footageSearch(@Param('projectId') projectId: string, @Query() raw: unknown) {
    return mapErrors(async () => {
      const q = parseBody(FootageQuerySchema, raw);
      const projectIds = await this.footageScope(projectId, q);
      if (!projectIds.length) return { items: [], nextCursor: null, total: 0 };
      const { agGoProjectId: _one, agGoProjectIds: _many, ...filters } = q;
      const r = await this.footage.searchForPicker({ ...filters, projectIds, limit: q.limit ?? 40 });
      const state = await assetStates(this.engine.db, projectId);
      return { ...r, items: r.items.map((i) => ({ ...i, prepared: state(i.assetId) })) };
    });
  }

  /**
   * How many videos have each value of each filter under the others (ag-go's facets). The project facet lists the
   * projects picked for this project (ag-go's own leaves its filter out and stops at 30), with ag-go's count when it
   * gave one.
   */
  @Get('footage/facets')
  @Roles('viewer')
  footageFacets(@Param('projectId') projectId: string, @Query() raw: unknown) {
    return mapErrors(async () => {
      const q = parseBody(FootageQuerySchema, raw);
      const projectIds = await this.footageScope(projectId, q);
      const picked = (await listSources(this.engine.db, projectId)).filter((s) => s.kind === 'ag_go_project');
      const empty = { tags: [], genres: [], timesOfDay: [], orientations: [], resolutions: [], categories: [], provinces: [], authors: [] };
      if (!projectIds.length) return { ...empty, projects: [] };
      const { agGoProjectId: _one, agGoProjectIds: _many, page: _p, cursor: _c, limit: _l, sortBy: _s, sortOrder: _o, ...filters } = q;
      const f = await this.footage.facets({ ...filters, projectIds });
      const counts = new Map(f.projects.map((p) => [p.value, p.count]));
      return { ...f, projects: picked.map((s) => ({ value: s.ref, label: s.label, count: counts.get(s.ref) ?? null })) };
    });
  }

  /** The ag-go projects a footage query looks in: those asked for (each must be picked here), else every picked one. */
  private async footageScope(projectId: string, q: { agGoProjectId?: string | undefined; agGoProjectIds?: string[] | undefined }): Promise<string[]> {
    await requireProject(this.engine.db, projectId);
    const picked = (await listSources(this.engine.db, projectId)).filter((s) => s.kind === 'ag_go_project').map((s) => s.ref);
    const asked = [...new Set([...(q.agGoProjectIds ?? []), ...(q.agGoProjectId ? [q.agGoProjectId] : [])])];
    const stray = asked.filter((id) => !picked.includes(id));
    if (stray.length) throw new StudioRunError('invalid', `project ${this.siteName.current()} này chưa thuộc đầu vào của dự án`, { code: 'not_an_input', ids: stray });
    return asked.length ? asked : picked;
  }

  /** Prepares ag-go videos of the project (background jobs; the video's thread is told when each ends). */
  @Post('prepare')
  @Roles('editor')
  prepare(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(async () => {
      const body = parseBody(PrepareSchema, raw);
      const project = await requireProject(this.engine.db, projectId);
      const first = (await listSources(this.engine.db, projectId)).find((s) => s.kind === 'ag_go_asset' && body.assetIds.includes(s.ref) && s.video_id);
      return {
        assets: await queuePrepare(this.engine.db, {
          projectId, assetIds: body.assetIds, threadId: await this.videoThreadId(first?.video_id ?? undefined), createdBy: req.authContext!.userId,
          actorRole: await roleOf(this.engine, req, project.team_id), ...(body.again ? { again: true } : {}),
        }, new Date().toISOString()),
      };
    });
  }

  @Get('jobs')
  @Roles('viewer')
  jobs(@Param('projectId') projectId: string, @Query('active') active?: string, @Query('videoId') videoId?: string): Promise<{ jobs: JobView[] }> {
    return mapErrors(async () => {
      await requireProject(this.engine.db, projectId);
      return { jobs: (await listJobs(this.engine.db, projectId, { ...(active === '1' ? { active: true } : {}), ...(videoId ? { videoId } : {}), limit: 50 })).map(jobView) };
    });
  }

  /** Stop: a job in line is cancelled at once; a running one stops within seconds (its ffmpeg killed, its farm job cancelled). */
  @Post('jobs/:jobId/cancel')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('projectId') projectId: string, @Param('jobId') jobId: string): Promise<JobView> {
    return mapErrors(async () => {
      const j = await requireJob(this.engine.db, jobId);
      if (j.project_id !== projectId) throw new StudioRunError('not_found', `không có việc ${jobId}`);
      return jobView(await requestJobCancel(this.engine.db, jobId));
    });
  }

  /** Why an ag-go project cannot be added, as said to the person who tried. */
  private cannotAdd(state: Exclude<AgGoAddability, 'addable'>): StudioRunError {
    const site = this.siteName.current();
    if (state === 'view_only') {
      return new StudioRunError('invalid', `Bạn chỉ xem được project này trên ${site} (bản có watermark): cần quyền tải bản gốc của project để thêm vào dự án`, { code: 'ag_go_view_only' });
    }
    if (state === 'no_videos') return new StudioRunError('invalid', `Project ${site} này chưa có video đã phân tích dùng được`, { code: 'ag_go_no_videos' });
    return new StudioRunError('invalid', `Bạn không thấy project này trên ${site}`, { code: 'ag_go_not_visible' });
  }

  /**
   * Refuses to remove the ag-go project `ref` while videos added to the project (or to its videos) belong to it and to
   * no other ag-go project of the project: ag-go would no longer serve them (409 `project_in_use`).
   */
  private async refuseInUse(projectId: string, ref: string): Promise<void> {
    const db = this.engine.db;
    const assets = (await listSources(db, projectId)).filter((x) => x.kind === 'ag_go_asset');
    if (!assets.length) return;
    const others = (await agGoProjectIds(db, projectId)).filter((id) => id !== ref);
    const { missing } = await this.footage.check(others, [...new Set(assets.map((x) => x.ref))]);
    if (!missing.length) return;
    const used = assets.filter((x) => missing.includes(x.ref));
    const videoIds = [...new Set(used.map((x) => x.video_id).filter((v): v is string => !!v))];
    const titles = videoIds.length
      ? (await db.all<{ title: string }>(`SELECT title FROM videos WHERE id IN (${videoIds.map(() => '?').join(', ')}) ORDER BY idx`, videoIds)).map((v) => v.title)
      : [];
    throw new StudioRunError('conflict', `${missing.length} video đang dùng thuộc project ${this.siteName.current()} này: gỡ thì các video đó không render được nữa`, {
      code: 'project_in_use', assets: missing.length, videos: titles,
    });
  }

  private async item(projectId: string, sourceId: string): Promise<SourceItem> {
    return (await sourceItems(this.engine.db, projectId)).find((s) => s.id === sourceId)!;
  }

  /** The main thread of a video (told when its jobs end); none for project-wide work. */
  private async videoThreadId(videoId: string | undefined): Promise<string | null> {
    if (!videoId) return null;
    return (await this.engine.db.get<{ id: string }>("SELECT id FROM agent_threads WHERE video_id = ? AND kind = 'video' AND archived_at IS NULL", [videoId]))?.id ?? null;
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
