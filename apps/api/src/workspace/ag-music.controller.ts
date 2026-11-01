import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AG_MUSIC_TRACK_TYPES } from '../ag-music/client';
import { RolesGuard } from '../auth/roles.guard';
import { mapErrors } from '../studio/http-errors';
import { AgMusicService } from './ag-music.service';
import { MediaLibraryService, type MediaItemResponse } from './media-library.service';
import { parseBody } from './zod-body';

const TracksSchema = z.object({
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  type: z.enum(AG_MUSIC_TRACK_TYPES).optional(),
  page: z.coerce.number().int().min(0).max(10_000).default(0),
  size: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const FetchSchema = z.object({ trackId: z.number().int().positive() }).strict();

/**
 * Picking music from ag-music-v2 into the person's own media library (2026-11-01): the approved tracks they may see
 * there, a link to listen, and the copy into the library. Everything is asked of ag-music as the person.
 */
@Controller('me/media/ag-music')
@UseGuards(RolesGuard)
export class AgMusicController {
  constructor(private readonly agMusic: AgMusicService, private readonly media: MediaLibraryService) {}

  /** Whether Studio is wired to ag-music (the web shows the picker only then). */
  @Get()
  status(): { enabled: boolean } {
    return { enabled: this.agMusic.enabled };
  }

  /** Approved tracks the person may see on ag-music, newest first: part of the name or code `q`, one `type`, paging. */
  @Get('tracks')
  tracks(@Query() raw: unknown, @Req() req: Request) {
    return mapErrors(() => this.agMusic.tracks(req.authContext!.userId, req.authContext!.accessToken, parseBody(TracksSchema, raw)));
  }

  @Get('tracks/:trackId/listen')
  listen(@Param('trackId', ParseIntPipe) trackId: number, @Req() req: Request) {
    return this.agMusic.listen(req.authContext!.accessToken, trackId);
  }

  /** The track's main audio into the library (the item already fetched from it when there is one); counts a download. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  fetch(@Body() raw: unknown, @Req() req: Request): Promise<MediaItemResponse> {
    return mapErrors(async () => {
      const { trackId } = parseBody(FetchSchema, raw);
      return this.media.view(await this.agMusic.fetch(req.authContext!.userId, req.authContext!.accessToken, trackId));
    });
  }
}
