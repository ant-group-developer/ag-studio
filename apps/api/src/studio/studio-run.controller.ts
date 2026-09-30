import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  cancelPlan,
  planRunView,
  readStageDocument,
  resumePlanRunFrom,
  retryStage,
  startPlanRun,
  STUDIO_GATES,
  submitStudioGate,
} from '@ag-studio/engine';
import { Roles, type TeamRole } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StudioDbService } from '../db/studio-db.service';
import { SubmitGateDto } from './dto';
import { EngineService } from './engine.service';
import { mapErrors } from './http-errors';

const ORDER: TeamRole[] = ['viewer', 'editor', 'producer', 'owner'];

/**
 * Plan run routes for GĐ2 (series): start the plan run, watch it, read stage documents,
 * submit the approve-plan gate, retry / resume / cancel.
 */
@Controller('productions/:id/run')
@UseGuards(RolesGuard)
export class StudioRunController {
  constructor(
    private readonly engine: EngineService,
    private readonly db: StudioDbService,
  ) {}

  @Post()
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  start(@Param('id') id: string) {
    return mapErrors(() => startPlanRun(this.engine.core, this.engine.db, id));
  }

  @Get()
  @Roles('viewer')
  status(@Param('id') id: string) {
    return mapErrors(() => planRunView(this.engine.core, this.engine.db, id));
  }

  /** A JSON document produced by a plan-run stage (e.g. `catalog/catalog.json`, `plan-episodes/series-plan.json`). */
  @Get('documents/:stage/:name')
  @Roles('viewer')
  document(@Param('id') id: string, @Param('stage') stage: string, @Param('name') name: string) {
    return mapErrors(() => {
      const runId = this.requireRunId(id);
      return readStageDocument(this.engine.core, runId, stage, name);
    });
  }

  /**
   * Submit the approve-plan gate: body `{document: SeriesPlan}`.
   * Returns `{accepted: true}` or 422 `{code: 'gate_rejected', failed: [...]}`.
   */
  @Post('gates/approve-plan')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approvePlan(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    this.requireRole(req, id, 'producer');
    return mapErrors(async () => {
      const runId = this.requireRunId(id);
      const report = await submitStudioGate(
        this.engine.core, this.engine.db, runId, 'approve-plan', dto.document,
      );
      return { accepted: true, stageState: report.stageState, runState: report.runState };
    });
  }

  /** Generic gate submit (kept for backward compat; use /gates/approve-plan for the plan gate). */
  @Post('gates/:gate')
  @Roles('editor')
  submitGate(@Param('id') id: string, @Param('gate') gate: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    if (gate in STUDIO_GATES && gate !== 'edit') this.requireRole(req, id, 'producer');
    return mapErrors(async () => {
      const runId = this.requireRunId(id);
      const report = await submitStudioGate(this.engine.core, this.engine.db, runId, gate, dto.document);
      return { stageState: report.stageState, runState: report.runState };
    });
  }

  @Post('stages/:stage/retry')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('id') id: string, @Param('stage') stage: string) {
    return mapErrors(() => {
      const runId = this.requireRunId(id);
      retryStage(this.engine.core, runId, stage);
      return { ok: true };
    });
  }

  /** After a FAILED/CANCELLED plan run: a new run that keeps every stage before `stage` and runs `stage` onwards. */
  @Post('stages/:stage/resume')
  @Roles('producer')
  @HttpCode(HttpStatus.CREATED)
  resume(@Param('id') id: string, @Param('stage') stage: string) {
    return mapErrors(() => resumePlanRunFrom(this.engine.core, this.engine.db, id, stage));
  }

  @Post('cancel')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id') id: string) {
    return mapErrors(() => {
      cancelPlan(this.engine.core, this.engine.db, id);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireRunId(productionId: string): string {
    const row = this.db.get<{ run_id: string | null }>(
      'SELECT run_id FROM productions WHERE id = ?',
      [productionId],
    );
    if (!row?.run_id) throw new NotFoundException({ code: 'no_run', message: 'no plan run yet for this production' });
    return row.run_id;
  }

  private requireRole(req: Request, productionId: string, role: TeamRole): void {
    const row = this.db.get<{ role: TeamRole }>(
      'SELECT tm.role FROM team_members tm JOIN productions p ON p.team_id = tm.team_id WHERE p.id = ? AND tm.user_id = ?',
      [productionId, req.authContext!.userId],
    );
    if (!row || ORDER.indexOf(row.role) < ORDER.indexOf(role)) throw new ForbiddenException(`Requires role: ${role}`);
  }
}
