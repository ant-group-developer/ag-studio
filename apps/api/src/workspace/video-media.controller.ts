import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, PayloadTooLargeException, Post, Req,
  ServiceUnavailableException, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statSync } from 'node:fs';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AUDIO_MAX_BYTES, AudioImportError, clearProjectAudio, declineProjectNarration, getVideoRevision, importProjectAudio, jobView, latestVideoRevision,
  listJobs, listVideoRevisions, projectAudio, projectAudioSummary, queueFit, queueRender, readWorkspaceBytes, requireProject, requireVideo,
  resolveInside, StudioRunError, timelineSummary, videoRenders, VOICE_ORIGINS, type ActorRole, type JobView, type RenderKind,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { ProjectFootageService } from './project-footage.service';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

const ORDER: ActorRole[] = ['viewer', 'editor', 'producer', 'owner'];
const RenderSchema = z.object({
  kind: z.enum(['render_preview', 'render_final', 'export_premiere']),
  nodeId: z.string().uuid().optional(),
  media: z.enum(['proxy', 'original']).optional(),
}).strict();
const FromFileSchema = z.object({
  path: z.string().min(1).max(300),
  origin: z.enum(VOICE_ORIGINS).optional(),
  referenceText: z.string().max(500).nullable().optional(),
  gainDb: z.number().min(-40).max(0).optional(),
  ducking: z.boolean().optional(),
}).strict();

export interface RenderView {
  jobId: string;
  kind: RenderKind;
  revision: number;
  durationS: number | null;
  width: number | null;
  height: number | null;
  watermarked: boolean | null;
  sizeBytes: number | null;
  note: string;
  finishedAt: string | null;
  /** A short-lived link; null when the person's own ag-go rights do not cover every video in it. */
  url: string | null;
  urlHidden?: 'footage_scope';
}

/**
 * A video's media (spec 2026-10-10 agent-workspace §P6): its renders (with a link only for people whose own ag-go
 * rights cover its footage — sharing a project never widens anyone's footage), starting a render (a preview: editor;
 * the final render and the Premiere export: producer), its timeline, building it from the edit plan; and the project's
 * narration voice and music, picked from audio files uploaded to the Inputs tab.
 */
@Controller()
@UseGuards(RolesGuard)
export class VideoMediaController {
  private readonly scope = new Map<string, { at: number; ok: boolean }>();

  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly footage: ProjectFootageService,
    private readonly config: ConfigService,
  ) {}

  @Get('videos/:videoId/renders')
  @Roles('viewer')
  renders(@Param('videoId') videoId: string, @Req() req: Request): Promise<{ renders: RenderView[]; jobs: JobView[] }> {
    return mapErrors(async () => {
      const v = requireVideo(this.engine.db, videoId);
      const userId = req.authContext!.userId;
      const out: RenderView[] = [];
      for (const r of videoRenders(this.engine.db, v.project_id, v.id)) {
        const allowed = await this.coversFootage(userId, v.id, r.revision);
        const url = allowed ? await this.engine.bucket.signedGetUrl(r.key, this.engine.browserUrlTtl, r.kind === 'export_premiere' ? { downloadName: `${v.title.slice(0, 80)}.zip` } : {}) : null;
        out.push({
          jobId: r.jobId, kind: r.kind, revision: r.revision, durationS: r.duration_s, width: r.width, height: r.height, watermarked: r.watermarked,
          sizeBytes: r.size_bytes, note: r.note, finishedAt: r.finishedAt, url, ...(allowed ? {} : { urlHidden: 'footage_scope' as const }),
        });
      }
      const jobs = listJobs(this.engine.db, v.project_id, { videoId, limit: 30 })
        .filter((j) => ['render_preview', 'render_final', 'export_premiere', 'fit'].includes(j.kind) && j.status !== 'done').map(jobView);
      return { renders: out, jobs };
    });
  }

  @Post('videos/:videoId/renders')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  render(@Param('videoId') videoId: string, @Body() raw: unknown, @Req() req: Request): Promise<JobView> {
    return mapErrors(() => {
      const body = parseBody(RenderSchema, raw);
      const v = requireVideo(this.engine.db, videoId);
      const project = requireProject(this.engine.db, v.project_id);
      const role = this.roleOf(req, project.team_id);
      if (body.kind !== 'render_preview' && ORDER.indexOf(role) < ORDER.indexOf('producer')) {
        throw new ForbiddenException({ code: 'role', message: 'Render bản cuối và xuất Premiere cần vai producer' });
      }
      if (!latestVideoRevision(this.engine.db, videoId)) throw new StudioRunError('invalid', 'video chưa có timeline', { code: 'no_timeline' });
      return jobView(queueRender(this.engine.db, {
        projectId: v.project_id, videoId, kind: body.kind, createdBy: req.authContext!.userId, actorRole: role,
        request: { ...(body.nodeId ? { node_id: body.nodeId } : {}), ...(body.media ? { media: body.media } : {}) },
      }));
    });
  }

  @Get('videos/:videoId/timeline')
  @Roles('viewer')
  timeline(@Param('videoId') videoId: string) {
    return mapErrors(() => {
      const v = requireVideo(this.engine.db, videoId);
      const latest = latestVideoRevision(this.engine.db, v.id);
      return {
        latest: latest ? timelineSummary(latest.data, latest.revision, latest.label) : null,
        revisions: listVideoRevisions(this.engine.db, v.id).map((r) => ({ revision: r.revision, label: r.label, authorId: r.author_id, createdAt: r.created_at })),
      };
    });
  }

  @Post('videos/:videoId/timeline/fit')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  fit(@Param('videoId') videoId: string, @Req() req: Request): Promise<JobView> {
    return mapErrors(() => {
      const v = requireVideo(this.engine.db, videoId);
      const project = requireProject(this.engine.db, v.project_id);
      return jobView(queueFit(this.engine.db, { projectId: v.project_id, videoId, createdBy: req.authContext!.userId, actorRole: this.roleOf(req, project.team_id) }));
    });
  }

  @Get('projects/:projectId/audio')
  @Roles('viewer')
  audio(@Param('projectId') projectId: string) {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      const a = projectAudio(this.engine.db, projectId);
      return { voice: a.voice, music: a.music, summary: projectAudioSummary(this.engine.db, projectId) };
    });
  }

  /** A file of the workspace (uploaded to `context/audio/`…) becomes the project's voice sample (producer) or its music (editor). */
  @Post('projects/:projectId/audio/:kind/from-file')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  fromFile(@Param('projectId') projectId: string, @Param('kind') kind: string, @Body() raw: unknown, @Req() req: Request) {
    return mapErrors(async () => {
      if (kind !== 'voice' && kind !== 'music') throw new BadRequestException({ code: 'kind', message: 'voice hoặc music' });
      const body = parseBody(FromFileSchema, raw);
      const project = requireProject(this.engine.db, projectId);
      if (kind === 'voice' && ORDER.indexOf(this.roleOf(req, project.team_id)) < ORDER.indexOf('producer')) {
        throw new ForbiddenException({ code: 'role', message: 'Chọn giọng đọc cần vai producer' });
      }
      if (kind === 'voice' && !body.origin) throw new UnprocessableEntityException({ code: 'origin', message: 'Cho biết giọng này từ đâu: giọng máy, giọng của bạn, hay có bản quyền' });
      const dir = this.workspace.dir(projectId);
      const { abs } = resolveInside(dir, body.path);
      readWorkspaceBytes(dir, body.path); // exists and readable
      if (statSync(abs).size > AUDIO_MAX_BYTES[kind]) throw new PayloadTooLargeException({ code: 'audio_too_large', message: `File lớn hơn ${AUDIO_MAX_BYTES[kind] / 1024 / 1024} MB` });
      try {
        await importProjectAudio({ db: this.engine.db, bucket: this.engine.bucket, ...this.tools() }, {
          projectId, kind, file: abs, source: { kind: 'upload', filename: body.path.split('/').pop()!.slice(0, 255) }, userId: req.authContext!.userId,
          ...(body.origin ? { origin: body.origin } : {}), ...(body.referenceText !== undefined ? { referenceText: body.referenceText } : {}),
          ...(body.gainDb !== undefined ? { gainDb: body.gainDb } : {}), ...(body.ducking !== undefined ? { ducking: body.ducking } : {}),
        });
      } catch (e) {
        if (e instanceof AudioImportError) throw new UnprocessableEntityException({ code: e.code, message: e.message });
        throw e;
      }
      return this.audio(projectId);
    });
  }

  @Post('projects/:projectId/audio/voice/decline')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  decline(@Param('projectId') projectId: string, @Req() req: Request) {
    return mapErrors(async () => {
      requireProject(this.engine.db, projectId);
      declineProjectNarration(this.engine.db, projectId, req.authContext!.userId);
      return this.audio(projectId);
    });
  }

  @Delete('projects/:projectId/audio/:kind')
  @Roles('producer')
  clear(@Param('projectId') projectId: string, @Param('kind') kind: string) {
    return mapErrors(async () => {
      if (kind !== 'voice' && kind !== 'music') throw new BadRequestException({ code: 'kind', message: 'voice hoặc music' });
      requireProject(this.engine.db, projectId);
      clearProjectAudio(this.engine.db, projectId, kind);
      return this.audio(projectId);
    });
  }

  private tools(): { ffmpeg: string; ffprobe: string } {
    const ffmpeg = this.config.get<string>('STUDIO_FFMPEG_PATH');
    const ffprobe = this.config.get<string>('STUDIO_FFPROBE_PATH');
    if (!ffmpeg || !ffprobe) throw new ServiceUnavailableException({ code: 'audio_disabled', message: 'Máy Studio chưa cấu hình ffmpeg/ffprobe (STUDIO_FFMPEG_PATH, STUDIO_FFPROBE_PATH)' });
    return { ffmpeg, ffprobe };
  }

  private roleOf(req: Request, teamId: string): ActorRole {
    if (req.authContext?.isAdmin) return 'owner';
    return this.engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, req.authContext!.userId])?.role ?? 'viewer';
  }

  /** Whether ag-go serves every video of that timeline revision to this person (asked at most once a minute). */
  private async coversFootage(userId: string, videoId: string, revision: number): Promise<boolean> {
    const key = `${userId}:${videoId}:${revision}`;
    const hit = this.scope.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const rev = getVideoRevision(this.engine.db, videoId, revision);
    const assets = rev ? [...new Set(rev.data.clips.map((c) => c.asset_id))] : [];
    let ok = false;
    try { ok = assets.length > 0 && (await this.footage.check(userId, assets)).missing.length === 0; } catch { ok = false; }
    this.scope.set(key, { at: Date.now(), ok });
    return ok;
  }
}
