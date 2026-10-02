import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { editProductionDocument, productionDocument, recordHumanEdit, type ProductionDocKind, type ProductionDocView } from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SubmitGateDto } from './dto';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

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

  private edit(id: string, kind: ProductionDocKind, document: unknown, req: Request): Promise<SavedDoc> {
    return mapErrors(() => {
      const userId = req.authContext!.userId;
      const r = editProductionDocument(this.engine.core, this.engine.db, id, kind, document, userId);
      recordHumanEdit(this.engine.db, { userId, productionId: id, kind: kind === 'rnd' ? 'rnd_edit' : 'branding_edit', before: r.before, after: r.document });
      const view = kind === 'rnd' ? productionDocument(this.engine.db, id, 'rnd') : productionDocument(this.engine.db, id, 'branding');
      return { ...view, warnings: r.warnings };
    });
  }
}
