import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { deleteMediaItem, listMediaItems, renameMediaItem } from '@ag-studio/engine';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { MediaLibraryService, type MediaItemResponse } from './media-library.service';
import { SignUploadFields } from './raw-uploads';
import { parseBody } from './zod-body';

const ListSchema = z.object({
  kind: z.enum(['video', 'image', 'audio']).optional(),
  q: z.string().trim().max(200).optional().transform((v) => v || undefined),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).strict();
const SignSchema = z.object({ ...SignUploadFields, use: z.enum(['footage', 'audio', 'reference']).optional() }).strict();
const AddSchema = z.object({ uploadKey: z.string().min(1).max(300), name: z.string().trim().min(1).max(255) }).strict();
const RenameSchema = z.object({ name: z.string().trim().min(1).max(255) }).strict();

export type { MediaItemResponse };

/**
 * The person's own media library (plan 2026-10-29 P2): the audio, videos and photos they uploaded, on the bucket under
 * them, picked again in any project without uploading twice. Only the owner sees or changes their items; a project
 * that uses one keeps using it whoever opens the project.
 */
@Controller('me/media')
@UseGuards(RolesGuard)
export class MediaController {
  constructor(private readonly engine: EngineService, private readonly media: MediaLibraryService) {}

  /** Newest first; `kind`, part of the name `q`, paging. Each with where it is used and a link to play or show it. */
  @Get()
  list(@Query() raw: unknown, @Req() req: Request): Promise<{ items: MediaItemResponse[]; total: number; bytes: number }> {
    return mapErrors(async () => {
      const q = parseBody(ListSchema, raw);
      const r = await listMediaItems(this.engine.db, req.authContext!.userId, q);
      return { ...r, items: await this.media.withPreviews(r.items) };
    });
  }

  /** A link to put one file into the library (`use` checks it as that use will: a reference video ≤ 300 MB…). */
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  sign(@Body() raw: unknown, @Req() req: Request) {
    const body = parseBody(SignSchema, raw);
    return this.media.sign(req.authContext!.userId, body.name, body.size, body.contentType, body.use);
  }

  /** The file the browser put at `uploadKey` becomes an item (the same key again is the same item). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(@Body() raw: unknown, @Req() req: Request): Promise<MediaItemResponse> {
    return mapErrors(async () => {
      const body = parseBody(AddSchema, raw);
      return this.media.view(await this.media.take(req.authContext!.userId, body.uploadKey, body.name));
    });
  }

  @Patch(':mediaId')
  rename(@Param('mediaId') mediaId: string, @Body() raw: unknown, @Req() req: Request): Promise<MediaItemResponse> {
    return mapErrors(async () => this.media.view(await renameMediaItem(this.engine.db, req.authContext!.userId, mediaId, parseBody(RenameSchema, raw).name)));
  }

  /** 409 `media_in_use` (with `projects`) while a project uses it. */
  @Delete(':mediaId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('mediaId') mediaId: string, @Req() req: Request): Promise<void> {
    await mapErrors(() => deleteMediaItem(this.engine.db, req.authContext!.userId, mediaId));
  }
}
