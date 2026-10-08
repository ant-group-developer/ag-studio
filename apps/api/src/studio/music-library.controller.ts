import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Request } from 'express';
import { z } from 'zod';
import {
  AUDIO_MAX_BYTES,
  AudioImportError,
  getLibraryMusic,
  importLibraryMusic,
  LIBRARY_MUSIC_ORIGINS,
  listLibraryMusic,
  saveLibraryMusic,
} from '@ag-studio/engine';
import { AccountApiService } from '../auth/account-api.service';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

/** What multer leaves on disk for an upload. */
interface UploadedAudio { path: string; originalname: string; size: number }

const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
/** Moods as a JSON array or one comma-separated form field. */
const moods = z.union([z.array(z.string()), z.string().transform((v) => v.split(','))])
  .transform((list) => [...new Set(list.map((m) => m.trim()).filter(Boolean))])
  .pipe(z.array(z.string().max(40)).min(1).max(10));

const UploadSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  moods,
  origin: z.enum(LIBRARY_MUSIC_ORIGINS),
  originNote: z.string().trim().min(1).max(500),
  loopOk: bool.optional(),
});
const PatchSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  moods: moods.optional(),
  active: z.boolean().optional(),
}).strict();

/**
 * The team's music library (plan 2026-10-08 task 29): background tracks tagged by mood that a shot-cut episode with no
 * music of its own is given (cut 1.1.0). Everyone signed in lists them (to pick one in the editor); only a Studio admin
 * adds, retags or retires one. A retired track stays on the bucket: timelines that use it still render.
 */
@Controller('studio/music')
export class MusicLibraryController {
  constructor(
    private readonly engine: EngineService,
    private readonly accountApi: AccountApiService,
    private readonly config: ConfigService,
  ) {}

  /** `{tracks: [{trackId, displayName, moods, durationSeconds, loopOk, origin, originNote, active, track, listenUrl}]}` */
  @Get()
  async list(@Req() req: Request) {
    const isAdmin = await this.isAdmin(req);
    const tracks = listLibraryMusic(this.engine.db, { activeOnly: !isAdmin });
    return { tracks: await Promise.all(tracks.map((t) => this.view(t))) };
  }

  /** Multipart: `file` and `displayName`, `moods` (comma-separated), `origin`, `originNote`, `loopOk`. Admin only. */
  @Post()
  @UseInterceptors(FileInterceptor('file', { dest: tmpdir(), limits: { fileSize: AUDIO_MAX_BYTES.music, files: 1 } }))
  async add(@Body() raw: Record<string, unknown>, @UploadedFile() file: UploadedAudio | undefined, @Req() req: Request) {
    try {
      await this.requireAdmin(req);
      const body = this.parse(UploadSchema, raw);
      if (!file) throw new BadRequestException({ code: 'audio_missing', message: 'Chọn file nhạc' });
      if (file.size > AUDIO_MAX_BYTES.music) {
        throw new PayloadTooLargeException({ code: 'audio_too_large', message: `File lớn hơn ${AUDIO_MAX_BYTES.music / 1024 / 1024} MB` });
      }
      const track = await importLibraryMusic({ db: this.engine.db, bucket: this.engine.bucket, ...this.tools() }, {
        file: file.path, displayName: body.displayName, moods: body.moods, origin: body.origin, originNote: body.originNote,
        loopOk: body.loopOk ?? false, now: this.engine.core.clock.now(),
      });
      return this.view(track);
    } catch (e) {
      if (e instanceof AudioImportError) throw libraryHttpError(e);
      if (e instanceof HttpException) throw e;
      return mapErrors(() => { throw e; });
    } finally {
      if (file) rmSync(file.path, { force: true });
    }
  }

  /** Rename, retag, retire (`active: false`) or bring back a track. Admin only. */
  @Patch(':trackId')
  async update(@Param('trackId') trackId: string, @Body() raw: Record<string, unknown>, @Req() req: Request) {
    await this.requireAdmin(req);
    const body = this.parse(PatchSchema, raw);
    const t = getLibraryMusic(this.engine.db, trackId);
    if (!t) throw new NotFoundException({ code: 'not_found', message: `no music track ${trackId}` });
    const next = {
      ...t,
      ...(body.displayName !== undefined ? { display_name: body.displayName } : {}),
      ...(body.moods !== undefined ? { mood: body.moods } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      updated_at: this.engine.core.clock.now(),
    };
    saveLibraryMusic(this.engine.db, next);
    return this.view(next);
  }

  private async view(t: ReturnType<typeof listLibraryMusic>[number]) {
    return {
      trackId: t.track_id, displayName: t.display_name, moods: t.mood, durationSeconds: t.duration_seconds, loopOk: t.loop_ok,
      origin: t.origin, originNote: t.origin_note, active: t.active, track: t.file,
      listenUrl: await this.engine.bucket.signedGetUrl(`library/${t.file.slice('library:'.length)}`, this.engine.browserUrlTtl),
    };
  }

  private parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new BadRequestException({ code: 'invalid', message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    }
    return parsed.data;
  }

  private tools() {
    const ffmpeg = this.config.get<string>('STUDIO_FFMPEG_PATH');
    const ffprobe = this.config.get<string>('STUDIO_FFPROBE_PATH');
    if (!ffmpeg || !ffprobe) {
      throw new ServiceUnavailableException({ code: 'audio_disabled', message: 'Máy Studio chưa cấu hình ffmpeg/ffprobe (STUDIO_FFMPEG_PATH, STUDIO_FFPROBE_PATH)' });
    }
    return { ffmpeg, ffprobe };
  }

  private async requireAdmin(req: Request): Promise<void> {
    if (!(await this.isAdmin(req))) throw new ForbiddenException('Requires a Studio admin');
  }

  private async isAdmin(req: Request): Promise<boolean> {
    const ctx = req.authContext!;
    if (ctx.isAdmin === undefined) {
      try { ctx.isAdmin = (await this.accountApi.getUserProfile(ctx.accessToken, ctx.userId)).userType === 'ADMIN'; }
      catch { ctx.isAdmin = false; }
    }
    return ctx.isAdmin;
  }
}

/** Engine refusals of a music file -> HTTP. */
function libraryHttpError(e: AudioImportError): HttpException {
  const body = { code: e.code, message: e.message };
  if (e.code === 'audio_too_large') return new PayloadTooLargeException(body);
  return new UnprocessableEntityException(body);
}
