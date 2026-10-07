import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Post,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { Request } from 'express';
import { z } from 'zod';
import {
  AUDIO_MAX_BYTES,
  AudioImportError,
  clearProductionAudio,
  declineNarration,
  fetchAudioUrl,
  getProduction,
  importProductionAudio,
  productionAudio,
  recordHumanEdit,
  resumeVoiceWaiting,
  VOICE_ORIGINS,
  type AudioKind,
  type AudioSource,
  type AudioTools,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

/** What multer leaves on disk for an upload. */
interface UploadedAudio { path: string; originalname: string; size: number }

const KINDS: readonly AudioKind[] = ['voice', 'music'];

/** Fields of a form (strings) or a JSON body. */
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const AudioBodySchema = z.object({
  url: z.string().max(2000).optional(),
  origin: z.enum(VOICE_ORIGINS).optional(),
  confirm: bool.optional(),
  referenceText: z.string().max(2000).optional(),
  gainDb: num.pipe(z.number().min(-40).max(0)).optional(),
  ducking: bool.optional(),
});

/** Engine refusals of an audio file or link -> HTTP. */
function audioHttpError(e: AudioImportError): HttpException {
  const body = { code: e.code, message: e.message };
  if (e.code === 'url_not_allowed') return new BadRequestException(body);
  if (e.code === 'url_fetch_failed') return new BadGatewayException(body);
  if (e.code === 'audio_too_large') return new PayloadTooLargeException(body);
  return new UnprocessableEntityException(body);
}

/**
 * Audio a person gives a production (ADR-0001 items 167-168): a voice sample to read narration in, background music,
 * as a link or an uploaded file; or narration declined. Giving a voice or declining runs on the episodes that stopped
 * at `tts` waiting for one. Base route: `/productions/:id/audio`.
 */
@Controller('productions/:id/audio')
@UseGuards(RolesGuard)
export class ProductionAudioController {
  constructor(
    private readonly engine: EngineService,
    private readonly config: ConfigService,
  ) {}

  private tools(): AudioTools {
    const ffmpeg = this.config.get<string>('STUDIO_FFMPEG_PATH');
    const ffprobe = this.config.get<string>('STUDIO_FFPROBE_PATH');
    if (!ffmpeg || !ffprobe) {
      throw new ServiceUnavailableException({ code: 'audio_disabled', message: 'Máy Studio chưa cấu hình ffmpeg/ffprobe (STUDIO_FFMPEG_PATH, STUDIO_FFPROBE_PATH)' });
    }
    return { ffmpeg, ffprobe };
  }

  /** The local stack fetches from its own machines (ag-go on localhost); a deployed one never reaches inside. */
  private allowPrivateUrls(): boolean {
    const v = this.config.get<unknown>('STUDIO_AUDIO_ALLOW_PRIVATE_URLS');
    return v === true || v === 'true' || v === '1';
  }

  private requireProduction(id: string) {
    const p = getProduction(this.engine.db, id);
    if (!p) throw new NotFoundException({ code: 'not_found', message: `production ${id} not found` });
    return p;
  }

  /** What the production has: its voice (or narration declined) and its music, each with a URL to listen to. */
  @Get()
  @Roles('viewer')
  get(@Param('id') id: string) {
    return mapErrors(async () => {
      const a = productionAudio(this.requireProduction(id));
      const listen = (input: string) => this.engine.bucket.signedGetUrl(`library/${input.slice('library:'.length)}`, this.engine.browserUrlTtl);
      // only files the person gave are ours to play back (a Studio default or a typed library: track may be anywhere)
      const voice = a.voice?.mode === 'clone'
        ? { ...a.voice, listenUrl: a.voice.source ? await listen(a.voice.reference) : null }
        : a.voice;
      const music = a.music ? { ...a.music, listenUrl: a.music.source ? await listen(a.music.track) : null } : null;
      return { voice, music };
    });
  }

  /**
   * A voice sample or music, as `file` (multipart) or `{ url }`. A voice needs `origin` and `confirm: true` (the person
   * vouches they may use it, ADR-0001 item 105). Answers what the production now has and the episodes run on.
   */
  @Post(':kind')
  @Roles('editor')
  @UseInterceptors(FileInterceptor('file', {
    dest: tmpdir(),
    limits: { fileSize: AUDIO_MAX_BYTES.music, files: 1 },
  }))
  give(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() raw: Record<string, unknown>,
    @UploadedFile() file: UploadedAudio | undefined,
    @Req() req: Request,
  ) {
    return mapErrors(async () => {
      try {
        if (!KINDS.includes(kind as AudioKind)) throw new NotFoundException({ code: 'not_found', message: `no audio kind ${kind}` });
        const k = kind as AudioKind;
        const p = this.requireProduction(id);
        const parsed = AudioBodySchema.safeParse(raw ?? {});
        if (!parsed.success) throw new BadRequestException({ code: 'invalid', message: parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
        const body = parsed.data;
        if (!file && !body.url) throw new BadRequestException({ code: 'audio_missing', message: 'Dán link hoặc chọn file audio' });
        if (k === 'voice' && (!body.origin || body.confirm !== true)) {
          throw new BadRequestException({ code: 'voice_consent', message: 'Chọn nguồn gốc giọng và xác nhận bạn có quyền dùng giọng này' });
        }
        if (file && file.size > AUDIO_MAX_BYTES[k]) {
          throw new PayloadTooLargeException({ code: 'audio_too_large', message: `File lớn hơn ${AUDIO_MAX_BYTES[k] / 1024 / 1024} MB` });
        }
        const tools = this.tools();
        const userId = req.authContext!.userId;
        const work = mkdtempSync(join(tmpdir(), 'studio-audio-in-'));
        try {
          let path: string;
          let source: AudioSource;
          if (file) {
            path = file.path;
            source = { kind: 'upload', filename: file.originalname.slice(0, 255) || `audio${extname(file.path)}` };
          } else {
            path = join(work, 'download');
            await fetchAudioUrl(body.url!, path, {
              maxBytes: AUDIO_MAX_BYTES[k], allowPrivate: this.allowPrivateUrls(),
            });
            source = { kind: 'link', url: body.url!.trim() };
          }
          const before = k === 'voice' ? p.voice : p.music;
          const after = await importProductionAudio({ db: this.engine.db, bucket: this.engine.bucket, ...tools }, {
            productionId: id, kind: k, file: path, source, userId,
            ...(body.origin ? { origin: body.origin } : {}),
            ...(body.referenceText !== undefined ? { referenceText: body.referenceText } : {}),
            ...(body.gainDb !== undefined ? { gainDb: body.gainDb } : {}),
            ...(body.ducking !== undefined ? { ducking: body.ducking } : {}),
          });
          recordHumanEdit(this.engine.db, { userId, productionId: id, kind: k, before: before ? JSON.parse(before) : null, after });
          const resumed = k === 'voice' ? resumeVoiceWaiting(this.engine.core, this.engine.db, id) : [];
          return { ...(await this.get(id)), resumedEpisodes: resumed };
        } finally {
          rmSync(work, { recursive: true, force: true });
          if (file) rmSync(file.path, { force: true });
        }
      } catch (e) {
        if (e instanceof AudioImportError) throw audioHttpError(e);
        throw e;
      }
    });
  }

  /** "Bỏ lời dẫn": the production has no narration; episodes waiting for a voice are cut without lines. */
  @Post('voice/none')
  @Roles('editor')
  decline(@Param('id') id: string, @Req() req: Request) {
    return mapErrors(async () => {
      const p = this.requireProduction(id);
      const userId = req.authContext!.userId;
      const after = declineNarration(this.engine.db, id, userId);
      recordHumanEdit(this.engine.db, { userId, productionId: id, kind: 'voice', before: p.voice ? JSON.parse(p.voice) : null, after });
      const resumed = resumeVoiceWaiting(this.engine.core, this.engine.db, id);
      return { ...(await this.get(id)), resumedEpisodes: resumed };
    });
  }

  /** Forget the voice (back to "not asked") or the music (none). The file stays in the bucket for runs that used it. */
  @Delete(':kind')
  @Roles('editor')
  remove(@Param('id') id: string, @Param('kind') kind: string, @Req() req: Request) {
    return mapErrors(async () => {
      if (!KINDS.includes(kind as AudioKind)) throw new NotFoundException({ code: 'not_found', message: `no audio kind ${kind}` });
      const p = this.requireProduction(id);
      const before = kind === 'voice' ? p.voice : p.music;
      clearProductionAudio(this.engine.db, id, kind as AudioKind);
      recordHumanEdit(this.engine.db, { userId: req.authContext!.userId, productionId: id, kind: kind as AudioKind, before: before ? JSON.parse(before) : null, after: null });
      return this.get(id);
    });
  }
}
