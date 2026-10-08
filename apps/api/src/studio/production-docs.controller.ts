import { Body, Controller, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { editProductionDocument, getProduction, productionDocument, recordHumanEdit, StudioRunError, styleFrameKey, type ProductionDocKind, type ProductionDocView } from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SubmitGateDto } from './dto';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

const MAX_STYLE_FRAMES = 12;
const EDIT_KINDS = { rnd: 'rnd_edit', branding: 'branding_edit', style: 'style_edit' } as const;

/** What a save answers: the saved document and the check's warnings (they never block a person's choice). */
type SavedDoc = ProductionDocView<unknown> & { warnings: { code: string; message: string }[] };

/**
 * The production's R&D and branding as approved (or edited since): read them, and edit them by hand. An edit only
 * reaches later AI steps — the next episode runs, and a re-plan from the `brief` stage.
 */
@Controller('productions/:id')
@UseGuards(RolesGuard)
export class ProductionDocsController {
  constructor(private readonly engine: EngineService) {}

  @Get('rnd')
  @Roles('viewer')
  rnd(@Param('id') id: string) {
    return mapErrors(() => productionDocument(this.engine.db, id, 'rnd'));
  }

  /** Body `{document: StudioRnd}`. 409 `not_approved_yet` / `gate_waiting` / `apply_pending`; 422 with `problems`. */
  @Put('rnd')
  @Roles('producer')
  putRnd(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request): Promise<SavedDoc> {
    return this.edit(id, 'rnd', dto.document, req);
  }

  @Get('branding')
  @Roles('viewer')
  branding(@Param('id') id: string) {
    return mapErrors(() => productionDocument(this.engine.db, id, 'branding'));
  }

  /** Body `{document: StudioBranding}`. Same answers as PUT rnd. */
  @Put('branding')
  @Roles('producer')
  putBranding(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request): Promise<SavedDoc> {
    return this.edit(id, 'branding', dto.document, req);
  }

  /** Series plan 3.2.0: the edit style learned from reference videos, as approved (or edited since). */
  @Get('style')
  @Roles('viewer')
  style(@Param('id') id: string) {
    return mapErrors(() => productionDocument(this.engine.db, id, 'style'));
  }

  /** Body `{document: StudioStyle}`. Same answers as PUT rnd (checked without the frames: they are not re-read). */
  @Put('style')
  @Roles('producer')
  putStyle(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request): Promise<SavedDoc> {
    return this.edit(id, 'style', dto.document, req);
  }

  /**
   * Short-lived URLs of frames of the reference videos (`?at=<video id>@<seconds>,…`, at most 12): the evidence a
   * style cites. They are frames of YouTube videos the production learned from (not ag-go footage), kept under the
   * production on the bucket, so the team's viewers may see them. 422 for anything that is not `<11-char id>@<t>`.
   */
  @Get('style/frames')
  @Roles('viewer')
  async styleFrames(@Param('id') id: string, @Query('at') at: string): Promise<{ frames: { video_id: string; t: number; url: string }[] }> {
    const list = await mapErrors(() => {
      if (!getProduction(this.engine.db, id)) throw new StudioRunError('not_found', `production ${id} not found`);
      return String(at ?? '').split(',').filter(Boolean).slice(0, MAX_STYLE_FRAMES).map((x) => {
        const m = /^([\w-]{11})@(\d{1,5}(?:\.\d{1,3})?)$/.exec(x.trim());
        if (!m) throw new StudioRunError('invalid', `"${x}" không phải <id video>@<giây>`, { code: 'bad_frame' });
        return { video_id: m[1]!, t: Number(m[2]) };
      });
    });
    const sign = (f: { video_id: string; t: number }) => this.engine.bucket.signedGetUrl(styleFrameKey(id, f.video_id, f.t), this.engine.browserUrlTtl);
    return { frames: await Promise.all(list.map(async (f) => ({ ...f, url: await sign(f) }))) };
  }

  private edit(id: string, kind: ProductionDocKind, document: unknown, req: Request): Promise<SavedDoc> {
    return mapErrors(() => {
      const userId = req.authContext!.userId;
      const r = editProductionDocument(this.engine.core, this.engine.db, id, kind, document, userId);
      recordHumanEdit(this.engine.db, { userId, productionId: id, kind: EDIT_KINDS[kind], before: r.before, after: r.document });
      const view = kind === 'rnd' ? productionDocument(this.engine.db, id, 'rnd') : kind === 'branding' ? productionDocument(this.engine.db, id, 'branding') : productionDocument(this.engine.db, id, 'style');
      return { ...view, warnings: r.warnings };
    });
  }
}
