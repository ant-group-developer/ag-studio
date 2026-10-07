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
  BadGatewayException,
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
  footageThumbnail,
  latestEpisodeRevision,
  cutEpisodeFrames,
  deleteThumbnail,
  episodeExport,
  episodeKit,
  canvaDesignThumbnailIds,
  episodeThumbnails,
  getEpisode,
  latestAcceptedCall,
  previewThumbnail,
  recordHumanEdit,
  requireThumbnail,
  selectThumbnail,
  selectedThumbnail,
  uploadThumbnail,
  type EpisodeRecord,
  type EpisodeThumbnail,
  type ThumbnailActionDeps,
  type ThumbnailRenderer,
  type ThumbnailStyle,
} from '@ag-studio/engine';
import { IsInt, IsNumber, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/roles.decorator';
import { CanvaService } from '../canva/canva.service';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';
import { ThumbnailWorkService } from './thumbnail-work.service';
import { thumbnailView, type ThumbnailView } from './thumbnail-view';

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

/** A picture of one of the episode's videos, before any render: its keyframe `keyframe` (none: the poster). */
class FootageDto {
  @IsString()
  @MaxLength(100)
  assetId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  keyframe?: number;

  /** The kit idea's words, drawn in the branding style; none: the clean picture. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  text?: string;
}

/** Largest keyframe the server takes from ag-go. */
const FOOTAGE_MAX_BYTES = 10 * 1024 * 1024;

class SelectDto {
  @IsString()
  @MaxLength(100)
  thumbnailId!: string;
}

/** Pictures a person uploads: JPEG, PNG or WebP of at most 10 MB (made a 2 MB JPEG before it is kept). */
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
interface UploadedPicture { buffer: Buffer; mimetype: string; size: number }

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
    private readonly canva: CanvaService,
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

  private view(ep: EpisodeRecord, t: EpisodeThumbnail): Promise<ThumbnailView> {
    return thumbnailView(this.engine, ep, t);
  }

  private async list(ep: EpisodeRecord, userId: string) {
    const rows = episodeThumbnails(this.deps, ep);
    const inCanva = canvaDesignThumbnailIds(this.engine.db, ep.id, userId);
    const picked = selectedThumbnail(this.engine.db, getEpisode(this.engine.db, ep.id) ?? ep);
    const cut = this.work.cutState(ep.id);
    const exp = episodeExport(this.engine.core, ep);
    return {
      items: await Promise.all(rows.map((t) => thumbnailView(this.engine, ep, t, inCanva.has(t.id)))),
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
      return { ...(await this.list(ep, req.authContext!.userId)), footageHidden: false };
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
      return { ...(await this.list(ep, req.authContext!.userId)), footageHidden: false };
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

  /**
   * At the YouTube kit gate, before any render: a keyframe of one of the episode's videos (signed by ag-go for this
   * person) with the kit idea's words drawn on it, kept as theirs and picked; a render keeps it.
   */
  @Post('footage')
  @Roles('editor')
  footage(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Body() dto: FootageDto, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      if (!latestEpisodeRevision(this.engine.db, ep.id)?.data.assets[dto.assetId]) {
        throw new UnprocessableEntityException({ code: 'asset_not_in_episode', message: 'video này không có trong tập' });
      }
      const userId = req.authContext!.userId;
      const media = await this.access.assetMedia(userId, dto.assetId);
      const url = dto.keyframe === undefined ? media.posterUrl ?? media.keyframes[0]?.url : media.keyframes[dto.keyframe]?.url;
      if (!url) throw new UnprocessableEntityException({ code: 'no_keyframe', message: 'video này chưa có ảnh khung' });
      const res = await fetch(url);
      const image = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (!image || image.length === 0 || image.length > FOOTAGE_MAX_BYTES) {
        throw new BadGatewayException({ code: 'keyframe_fetch_failed', message: `không tải được ảnh khung (HTTP ${res.status})` });
      }
      const t = await this.work.run(() => footageThumbnail(this.deps, renderer, ep, { assetId: dto.assetId, image, text: dto.text ?? null, userId }));
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

  /**
   * The picture as a design in the caller's Canva (words still editable when it has them): `{designId, editUrl}`.
   * 409 `canva_not_connected` / `canva_reconnect` when the caller has to (re)connect Canva first.
   */
  @Post(':thumbnailId/canva')
  @Roles('editor')
  @HttpCode(HttpStatus.OK)
  openInCanva(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Param('thumbnailId') thumbnailId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      return this.canva.openThumbnail(req.authContext!.userId, ep, requireThumbnail(this.engine.db, ep.id, thumbnailId));
    });
  }

  /** The design as edited in Canva, back as a new `canva` picture of the episode. */
  @Post(':thumbnailId/canva/pull')
  @Roles('editor')
  pullFromCanva(@Param('id') prodId: string, @Param('episodeId') episodeId: string, @Param('thumbnailId') thumbnailId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const ep = this.requireEpisode(prodId, episodeId);
      await this.requireCovers(req, prodId);
      const renderer = this.renderer();
      const source = requireThumbnail(this.engine.db, ep.id, thumbnailId);
      const t = await this.work.run(() => this.canva.pullThumbnail(req.authContext!.userId, ep, source, renderer));
      return this.view(ep, t);
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
      return { ...(await this.list(ep, req.authContext!.userId)), footageHidden: false };
    });
  }
}
