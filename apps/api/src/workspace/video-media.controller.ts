import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Logger, NotFoundException, Param, PayloadTooLargeException,
  Post, Req, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AUDIO_MAX_BYTES, AudioImportError, clearProjectAudio, declineProjectNarration, getLibraryMusic, getVideoRevision, importProjectAudio, jobView,
  latestVideoRevision, listJobs, listVideoRevisions, projectAudio, projectAudioFiles, projectAudioSummary, projectLibraryTrack, queueFit, queueRender,
  readWorkspaceBytes, requireProject, requireVideo, resolveInside, setProjectLibraryMusic, StudioRunError, timelineSummary, videoRender, videoRenders,
  VOICE_ORIGINS, type ActorRole, type JobView, type ProjectAudioFile, type RenderKind,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { audioTools, requireAudioTools } from '../studio/audio-tools';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { FootageRights, type FootageVerdict } from './footage-rights';
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
const FromLibrarySchema = z.object({
  trackId: z.string().min(1).max(80),
  gainDb: z.number().min(-40).max(0).optional(),
  ducking: z.boolean().optional(),
}).strict();

/** `GET projects/:id/audio`: what is chosen, whether this Studio can take audio in, and the audio files to pick from. */
export interface ProjectAudioResponse {
  voice: unknown;
  music: unknown;
  summary: { voice: string; music: string };
  /** The library track the music is, when it is one. */
  libraryTrack: { trackId: string; displayName: string; moods: string[]; durationSeconds: number } | null;
  /** ffmpeg (and ffprobe) are configured: files can be used as the voice sample or the music. A library track needs neither. */
  enabled: boolean;
  files: ProjectAudioFile[];
}

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
}

/** A render's link, asked for one render at a time (`GET videos/:videoId/renders/:jobId/link`). */
export interface RenderLink {
  jobId: string;
  /** A short-lived link; null when the person's own ag-go rights do not cover every video in it, or ag-go could not say. */
  url: string | null;
  /** `footage_scope`: ag-go does not serve every video of it to this person; `footage_check_failed`: ag-go did not answer. */
  urlHidden?: FootageVerdict;
}

/**
 * A video's media (spec 2026-10-10 agent-workspace §P6): its renders (with a link only for people whose own ag-go
 * rights cover its footage — sharing a project never widens anyone's footage), starting a render (a preview: editor;
 * the final render and the Premiere export: producer), its timeline, building it from the edit plan; and the project's
 * narration voice and music, picked from audio files uploaded to the Inputs tab (or put in `context/audio/`), the music
 * also from the music library.
 */
@Controller()
@UseGuards(RolesGuard)
export class VideoMediaController {
  private readonly logger = new Logger(VideoMediaController.name);
  private readonly rights: FootageRights;

  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    footage: ProjectFootageService,
    private readonly config: ConfigService,
  ) {
    this.rights = new FootageRights(footage, this.logger);
  }

  /** What the Preview tab lists, from the database alone (no ag-go, no signing): each render's link is asked for apart. */
  @Get('videos/:videoId/renders')
  @Roles('viewer')
  renders(@Param('videoId') videoId: string): Promise<{ renders: RenderView[]; jobs: JobView[]; thumbnails: string[] }> {
    return mapErrors(async () => {
      const v = requireVideo(this.engine.db, videoId);
      const out: RenderView[] = videoRenders(this.engine.db, v.project_id, v.id).map((r) => ({
        jobId: r.jobId, kind: r.kind, revision: r.revision, durationS: r.duration_s, width: r.width, height: r.height, watermarked: r.watermarked,
        sizeBytes: r.size_bytes, note: r.note, finishedAt: r.finishedAt,
      }));
      const jobs = listJobs(this.engine.db, v.project_id, { videoId, limit: 30 })
        .filter((j) => ['render_preview', 'render_final', 'export_premiere', 'fit', 'thumbnail'].includes(j.kind) && j.status !== 'done').map(jobView);
      // thumbnails made for it (workspace files the web reads like any other)
      const tdir = join(this.workspace.dir(v.project_id), 'videos', v.id, 'thumbnails');
      const thumbnails = existsSync(tdir) ? readdirSync(tdir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => `videos/${v.id}/thumbnails/${f}`) : [];
      return { renders: out, jobs, thumbnails };
    });
  }

  /**
   * One render's link, only for a person whose own ag-go rights cover every video of its timeline revision (sharing a
   * project never widens anyone's footage); a Premiere export's link names the .zip to save.
   */
  @Get('videos/:videoId/renders/:jobId/link')
  @Roles('viewer')
  link(@Param('videoId') videoId: string, @Param('jobId') jobId: string, @Req() req: Request): Promise<RenderLink> {
    return mapErrors(async () => {
      const v = requireVideo(this.engine.db, videoId);
      const r = videoRender(this.engine.db, v.id, jobId);
      if (!r) throw new StudioRunError('not_found', `video không có bản render ${jobId}`);
      const hidden = await this.footageVerdict(req.authContext!.userId, v.id, r.revision);
      if (hidden) return { jobId: r.jobId, url: null, urlHidden: hidden };
      const url = await this.engine.bucket.signedGetUrl(r.key, this.engine.browserUrlTtl, r.kind === 'export_premiere' ? { downloadName: `${v.title.slice(0, 80)}.zip` } : {});
      return { jobId: r.jobId, url };
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
  audio(@Param('projectId') projectId: string): Promise<ProjectAudioResponse> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      const a = projectAudio(this.engine.db, projectId);
      const lib = projectLibraryTrack(this.engine.db, projectId);
      return {
        voice: a.voice, music: a.music, summary: projectAudioSummary(this.engine.db, projectId),
        libraryTrack: lib ? { trackId: lib.track_id, displayName: lib.display_name, moods: lib.mood, durationSeconds: lib.duration_seconds } : null,
        enabled: audioTools(this.config) !== null,
        files: projectAudioFiles(this.engine.db, this.workspace.dir(projectId), projectId),
      };
    });
  }

  /** A track of the music library as the project's music (editor): nothing to convert, so it works without ffmpeg. */
  @Post('projects/:projectId/audio/music/from-library')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  fromLibrary(@Param('projectId') projectId: string, @Body() raw: unknown) {
    return mapErrors(async () => {
      const body = parseBody(FromLibrarySchema, raw);
      requireProject(this.engine.db, projectId);
      const track = getLibraryMusic(this.engine.db, body.trackId);
      if (!track) throw new NotFoundException({ code: 'not_found', message: `Không có bài ${body.trackId} trong kho nhạc` });
      try {
        setProjectLibraryMusic(this.engine.db, projectId, track, {
          ...(body.gainDb !== undefined ? { gainDb: body.gainDb } : {}), ...(body.ducking !== undefined ? { ducking: body.ducking } : {}),
        });
      } catch (e) {
        if (e instanceof AudioImportError) throw new UnprocessableEntityException({ code: e.code, message: e.message });
        throw e;
      }
      return this.audio(projectId);
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
        await importProjectAudio({ db: this.engine.db, bucket: this.engine.bucket, ...requireAudioTools(this.config) }, {
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

  /** Clearing the music: editor (as picking it); clearing the voice: producer. */
  @Delete('projects/:projectId/audio/:kind')
  @Roles('editor')
  clear(@Param('projectId') projectId: string, @Param('kind') kind: string, @Req() req: Request) {
    return mapErrors(async () => {
      if (kind !== 'voice' && kind !== 'music') throw new BadRequestException({ code: 'kind', message: 'voice hoặc music' });
      const project = requireProject(this.engine.db, projectId);
      if (kind === 'voice' && ORDER.indexOf(this.roleOf(req, project.team_id)) < ORDER.indexOf('producer')) {
        throw new ForbiddenException({ code: 'role', message: 'Bỏ chọn giọng đọc cần vai producer' });
      }
      clearProjectAudio(this.engine.db, projectId, kind);
      return this.audio(projectId);
    });
  }

  private roleOf(req: Request, teamId: string): ActorRole {
    if (req.authContext?.isAdmin) return 'owner';
    return this.engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, req.authContext!.userId])?.role ?? 'viewer';
  }

  /**
   * Why ag-go does not serve every video of that timeline revision to this person, or null when it does: answered from
   * what is known per ag-go video (`FootageRights`), asking ag-go only about the videos not known yet.
   */
  private footageVerdict(userId: string, videoId: string, revision: number): Promise<FootageVerdict | null> {
    const rev = getVideoRevision(this.engine.db, videoId, revision);
    return this.rights.verdict(userId, rev ? rev.data.clips.map((c) => c.asset_id) : [], `video ${videoId} r${revision}`);
  }
}
