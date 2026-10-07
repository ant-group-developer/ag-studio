import { Body, Controller, ForbiddenException, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import type { Request } from 'express';
import { editStepDocument, stepDocument, type StepDocKind, type StepDocView, type StepEditResult } from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

export class EditStepDto {
  /** The whole document of the step (trend report, R&D, branding, series plan, YouTube kit, survey, edit plan). */
  @IsObject() document!: Record<string, unknown>;
  /** true: open the step again with this version on show; false (default): replace the version in use. */
  @IsOptional() @IsBoolean() reopen?: boolean;
}

const MANAGES = new Set(['producer', 'owner']);

/**
 * A step's document after its approval (plan 2026-10-07 step history): read it again, and edit it — in place where
 * later steps read the version in use, or by reopening the step with the edit on show to approve again.
 */
@Controller('productions/:id')
@UseGuards(RolesGuard)
export class StepDocsController {
  constructor(private readonly engine: EngineService) {}

  @Get('steps/:kind')
  @Roles('viewer')
  seriesStep(@Param('id') id: string, @Param('kind') kind: string): Promise<StepDocView> {
    return mapErrors(() => stepDocument(this.engine.core, this.engine.db, { productionId: id, kind: kind as StepDocKind }));
  }

  /** 409 `at_gate` / `not_approved_yet` / `only_reopen` / `episode_producing` / `running`; 422 with `problems`. */
  @Put('steps/:kind')
  @Roles('producer')
  editSeriesStep(@Param('id') id: string, @Param('kind') kind: string, @Body() dto: EditStepDto, @Req() req: Request): Promise<StepEditResult & { view: StepDocView }> {
    return this.edit(id, null, kind as StepDocKind, dto, req);
  }

  @Get('episodes/:episodeId/steps/:kind')
  @Roles('viewer')
  episodeStep(@Param('id') id: string, @Param('episodeId') episodeId: string, @Param('kind') kind: string): Promise<StepDocView> {
    return mapErrors(() => stepDocument(this.engine.core, this.engine.db, { productionId: id, episodeId, kind: kind as StepDocKind }));
  }

  /** An editor may save the YouTube kit in place (as PATCH episode does); reopening a step needs a producer. */
  @Put('episodes/:episodeId/steps/:kind')
  @Roles('editor')
  editEpisodeStep(
    @Param('id') id: string, @Param('episodeId') episodeId: string, @Param('kind') kind: string, @Body() dto: EditStepDto, @Req() req: Request,
  ): Promise<StepEditResult & { view: StepDocView }> {
    if (dto.reopen || kind !== 'youtube_kit') this.requireProducer(id, req);
    return this.edit(id, episodeId, kind as StepDocKind, dto, req);
  }

  private edit(id: string, episodeId: string | null, kind: StepDocKind, dto: EditStepDto, req: Request) {
    return mapErrors(() => {
      const r = editStepDocument(this.engine.core, this.engine.db, {
        productionId: id, episodeId, kind, document: dto.document, reopen: dto.reopen ?? false, userId: req.authContext!.userId,
      });
      return { ...r, view: stepDocument(this.engine.core, this.engine.db, { productionId: id, episodeId, kind }) };
    });
  }

  /** RolesGuard let an editor in; this route needs more for anything but the kit in place (admins pass). */
  private requireProducer(productionId: string, req: Request): void {
    const ctx = req.authContext!;
    if (ctx.isAdmin) return;
    const row = this.engine.db.get<{ role: string }>(
      'SELECT m.role FROM team_members m JOIN productions p ON p.team_id = m.team_id WHERE p.id = ? AND m.user_id = ?', [productionId, ctx.userId],
    );
    if (!row || !MANAGES.has(row.role)) throw new ForbiddenException('Requires role: producer');
  }
}
