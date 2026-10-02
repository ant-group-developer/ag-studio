import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import {
  captureThumbnail,
  composeThumbnail,
  cutEpisodeFrames,
  deleteThumbnail,
  episodeExport,
  episodeKit,
  episodeThumbnails,
  fileSlug,
  getEpisode,
  latestAcceptedCall,
  madeByPerson,
  previewThumbnail,
  recordHumanEdit,
  selectThumbnail,
  selectedThumbnail,
  uploadThumbnail,
  type EpisodeRecord,
  type EpisodeThumbnail,
  type ThumbnailActionDeps,
  type ThumbnailRenderer,
  type ThumbnailStyle,
} from '@ag-studio/engine';
import { IsNumber, IsObject, IsString, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';
import { ThumbnailWorkService } from './thumbnail-work.service';

class WordsDto {
  @IsString()
  @MaxLength(100)
  baseId!: string;

  @IsString()
  @MaxLength(200)
  text!: string;

  @IsObject()
  style!: ThumbnailStyle;
}

class CaptureDto {
  @IsNumber()
  @Min(0)
  tS!: number;
}

class SelectDto {
  @IsString()
  @MaxLength(100)
  thumbnailId!: string;
}

/** Pictures a person uploads: JPEG, PNG or WebP of at most 10 MB (made a 2 MB JPEG before it is kept). */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
interface UploadedPicture { buffer: Buffer; mimetype: string; size: number }

export interface ThumbnailView {
  id: string; kind: EpisodeThumbnail['kind']; tS: number | null; assetId: string | null; parentId: string | null;
  text: string | null; style: ThumbnailStyle | null; width: number; height: number; sizeBytes: number;
  createdBy: string; createdAt: string; url: string; downloadUrl: string; deletable: boolean; drawable: boolean;
}

/**
 * The thumbnails of an episode (docs/studio-api-v3.md "Thumbnails"): every picture to pick from, the pick, and
 * what a person makes — words drawn on a picture (seen first), a captured moment, an upload. Pictures carry
 * footage, so they go only to someone whose own footage scope covers the production (as the video does).
 * Base route: `/productions/:id/episodes/:episodeId/thumbnails`
 */
@Controller('productions/:id/episodes/:episodeId/thumbnails')
@UseGuards(RolesGuard)
export class ThumbnailsController {
  private readonly logger = new Logger(ThumbnailsController.name);

  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
    private readonly work: ThumbnailWorkService,
  ) {}

  private get deps(): ThumbnailActionDeps {
    return { core: this.engine.core, db: this.engine.db, bucket: this.engine.bucket, urlTtlSeconds: this.engine.browserUrlTtl };
  }

  private requireEpisode(prodId: string, episodeId: string): EpisodeRecord {
    const ep = getEpisode(this.engine.db, episodeId);
    if (!ep || ep.production_id !== prodId) throw new NotFoundException({ code: 'not_found', message: `episode ${episodeId} not found` });
    return ep;
  }

  private async requireCovers(req: Request, prodId: string): Promise<void> {
    if (!(await this.access.coversProduction(req.authContext!.userId, prodId))) {
      throw new ForbiddenException({ code: 'footage_hidden', message: 'Bạn không có quyền xem footage của production này' });
    }
  }

  private renderer(): ThumbnailRenderer {
    const r = this.engine.thumbnails;
    if (!r) throw new ServiceUnavailableException({ code: 'thumbnails_unavailable', message: 'Máy chủ chưa có ffmpeg để vẽ thumbnail' });
    return r;
  }

  private async view(ep: EpisodeRecord, t: EpisodeThumbnail): Promise<ThumbnailView> {
    const ttl = this.engine.browserUrlTtl;
    const name = `${fileSlug(ep.title)}-${t.kind}-${t.id.slice(0, 8)}.jpg`;
    return {
      id: t.id, kind: t.kind, tS: t.t_s, assetId: t.asset_id, parentId: t.parent_id, text: t.text, style: t.style,
      width: t.width, height: t.height, sizeBytes: t.size_bytes, createdBy: t.created_by, createdAt: t.created_at,
      url: await this.engine.bucket.signedGetUrl(t.image_key, ttl),
      downloadUrl: await this.engine.bucket.signedGetUrl(t.image_key, ttl, { downloadName: name }),
      deletable: madeByPerson(t),
      // words go on a clean picture (a frame, an upload, the frame under a suggestion or drawn picture); a Canva
      // design has its own words, and a picture from before 1.2.0 has them burnt in with no clean frame kept
      drawable: t.kind !== 'canva' && t.base_key !== null,
    };
  }

  private async list(ep: EpisodeRecord) {
    const rows = episodeThumbnails(this.deps, ep);
    const picked = selectedThumbnail(this.engine.db, getEpisode(this.engine.db, ep.id) ?? ep);
    const cut = this.work.cutState(ep.id);
    const exp = episodeExport(this.engine.core, ep);
    return {
      items: await Promise.all(rows.map((t) => this.view(ep, t))),
      selectedId: picked?.id ?? null,
      canDraw: this.engine.thumbnails !== null,
      // an episode rendered before 1.2.0 has no clean frame yet: they can be cut from its video
      canCutFrames: this.engine.thumbnails !== null && !!exp && !rows.some((t) => t.kind === 'frame' && t.created_by === 'system' && t.source_run_id === exp.run_id),
      framesPending: cut.pending,
      framesError: cut.error,
    };
  }

  /** What Claude's kit suggested next to what the person picked (training dataset); never fails the action. */
  private recordPick(ep: EpisodeRecord, picked: EpisodeThumbnail, userId: string): void {
    try {
      const kit = episodeKit(this.engine.core, ep);
      recordHumanEdit(this.engine.db, {
        userId, productionId: ep.production_id, episodeId: ep.id, kind: 'thumbnail',
        before: kit ? { thumbnails: kit.thumbnails } : undefined,
        after: { kind: picked.kind, t_s: picked.t_s, asset_id: picked.asset_id, text: picked.text, style: picked.style, created_by: picked.created_by },
        llmCallId: ep.run_id ? latestAcceptedCall(this.engine.db, ep.run_id, 'youtube-kit') : null,
      });
    } catch (e) {
      this.logger.warn(`could not record the thumbnail pick of ${ep.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  @Get()
  @Roles('viewer')
  get(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      if (!(await this.access.coversProduction(req.authContext!.userId, prodId))) {
        return { items: [], selectedId: null, canDraw: false, canCutFrames: false, framesPending: false, framesError: null, footageHidden: true };
      }
      return { ...(await this.list(ep)), footageHidden: false };
    });
  }

  /** The picture the episode uses (the YouTube pack and the episode list follow it). */
  @Put('selected')
  @Roles('editor')
  select(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: SelectDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      episodeThumbnails(this.deps, ep);
      selectThumbnail(this.engine.db, ep.id, dto.thumbnailId);
      const picked = selectedThumbnail(this.engine.db, getEpisode(this.engine.db, ep.id)!)!;
      this.recordPick(ep, picked, req.authContext!.userId);
      return { ...(await this.list(ep)), footageHidden: false };
    });
  }

  /** The words drawn on the picture, at half size, not kept: `{ dataUrl }` to show while the person types. */
  @Post('preview')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  preview(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: WordsDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      const jpeg = await this.work.run(() => previewThumbnail(this.deps, renderer, ep, dto));
      return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` };
    });
  }

  @Post('compose')
  @Roles('editor')
  compose(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: WordsDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      const t = await this.work.run(() => composeThumbnail(this.deps, renderer, ep, dto, req.authContext!.userId));
      return this.view(ep, t);
    });
  }

  /** A clean frame of the final video at `tS` seconds (the moment the person paused the player on). */
  @Post('capture')
  @Roles('editor')
  capture(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: CaptureDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      const t = await this.work.run(() => captureThumbnail(this.deps, renderer, ep, dto.tS, req.authContext!.userId));
      return this.view(ep, t);
    });
  }

  @Post('upload')
  @Roles('editor')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } }))
  upload(
    @Param('id') prodId: string,
    @Param('episodeId') episodeId: string,
    @UploadedFile() file: UploadedPicture | undefined,
    @Req() req: Request,
  ) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      if (!file?.buffer?.length) throw new UnprocessableEntityException({ code: 'file_missing', message: 'Chưa chọn ảnh' });
      if (!UPLOAD_TYPES.includes(file.mimetype)) {
        throw new UnprocessableEntityException({ code: 'file_type', message: 'Chỉ nhận ảnh JPEG, PNG hoặc WebP' });
      }
      const renderer = this.renderer();
      const t = await this.work.run(() => uploadThumbnail(this.deps, renderer, ep, file.buffer, req.authContext!.userId));
      return this.view(ep, t);
    });
  }

  /** Cut the clean frames of an episode rendered before 1.2.0 (in the background; the list shows when they land). */
  @Post('frames')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  frames(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      if (!episodeExport(this.engine.core, ep)) throw new UnprocessableEntityException({ code: 'no_final_video', message: 'Tập chưa có video final' });
      const started = this.work.startCut(ep.id, () => cutEpisodeFrames(this.deps, renderer, ep));
      return { started, pending: true };
    });
  }

  /** Delete a picture a person made (a render's frames and suggestions stay). */
  @Delete(':thumbnailId')
  @Roles('editor')
  remove(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Param('thumbnailId') thumbnailId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      deleteThumbnail(this.engine.db, ep.id, thumbnailId);
      return { ...(await this.list(ep)), footageHidden: false };
    });
  }
}
