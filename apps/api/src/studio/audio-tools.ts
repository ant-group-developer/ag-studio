import { ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ffprobeBeside, type AudioTools } from '@ag-studio/engine';

/**
 * ffmpeg and ffprobe for taking in audio (voice samples, music): `STUDIO_FFMPEG_PATH`, and `STUDIO_FFPROBE_PATH` or,
 * as the worker does, the ffprobe next to that ffmpeg. Null when ffmpeg is not configured.
 */
export function audioTools(config: ConfigService): AudioTools | null {
  const ffmpeg = config.get<string>('STUDIO_FFMPEG_PATH');
  if (!ffmpeg) return null;
  return { ffmpeg, ffprobe: config.get<string>('STUDIO_FFPROBE_PATH') || ffprobeBeside(ffmpeg) };
}

/** As `audioTools`, or 503 `audio_disabled`. */
export function requireAudioTools(config: ConfigService): AudioTools {
  const t = audioTools(config);
  if (!t) throw new ServiceUnavailableException({ code: 'audio_disabled', message: 'Máy Studio chưa cấu hình ffmpeg (STUDIO_FFMPEG_PATH)' });
  return t;
}
