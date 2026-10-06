import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  cancelPlan,
  latestAcceptedCall,
  planRunView,
  readStageDocument,
  recordHumanEdit,
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

/** Each approval gate: the stage whose document Claude proposed, and how the approval is kept in the dataset. */
const APPROVALS = {
  'approve-trend-report': { stage: 'trend-report', file: 'trend-report.json', kind: 'trend_report' },
  'approve-rnd': { stage: 'rnd', file: 'rnd.json', kind: 'rnd' },
  'approve-branding': { stage: 'branding', file: 'branding.json', kind: 'branding' },
  'approve-plan': { stage: 'plan-episodes', file: 'series-plan.json', kind: 'series_plan' },
} as const;

/**
 * Plan run routes for GĐ2 (series): start the plan run, watch it, read stage documents,
 * submit the approve-plan gate, retry / resume / cancel.
 */
@Controller('productions/:id/run')
@UseGuards(RolesGuard)
export class StudioRunController {
  private readonly logger = new Logger(StudioRunController.name);

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
   * Returns `{accepted: true}` or 422 `{code: 'rejected', failed: [{check_id, evidence: {problems}}]}`.
   */
  @Post('gates/approve-plan')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approvePlan(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    return this.approve(id, 'approve-plan', dto, req);
  }

  /** Submit the approve-trend-report gate (plan 3.0.0): body `{document: TrendReport}`. Same answers as approve-plan. */
  @Post('gates/approve-trend-report')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approveTrendReport(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    return this.approve(id, 'approve-trend-report', dto, req);
  }

  /** Submit the approve-rnd gate: body `{document: StudioRnd}` (Claude's R&D, edited). Same answers as approve-plan. */
  @Post('gates/approve-rnd')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approveRnd(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    return this.approve(id, 'approve-rnd', dto, req);
  }

  /** Submit the approve-branding gate: body `{document: StudioBranding}`. Same answers as approve-plan. */
  @Post('gates/approve-branding')
  @Roles('producer')
  @HttpCode(HttpStatus.OK)
  approveBranding(@Param('id') id: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    return this.approve(id, 'approve-branding', dto, req);
  }

  private approve(id: string, gate: keyof typeof APPROVALS, dto: SubmitGateDto, req: Request) {
    this.requireRole(req, id, 'producer');
    return mapErrors(async () => {
      const runId = this.requireRunId(id);
      const report = await submitStudioGate(this.engine.core, this.engine.db, runId, gate, dto.document);
      this.recordApproval(id, runId, gate, dto.document, req?.authContext?.userId);
      return { accepted: true, stageState: report.stageState, runState: report.runState };
    });
  }

  /** Claude's proposal next to the document approved (training dataset); never fails the approval. */
  private recordApproval(productionId: string, runId: string, gate: keyof typeof APPROVALS, approved: unknown, userId: string | undefined): void {
    if (!userId) return;
    const { stage, file, kind } = APPROVALS[gate];
    try {
      let proposed: unknown;
      try { proposed = readStageDocument(this.engine.core, runId, stage, file); } catch { proposed = undefined; }
      recordHumanEdit(this.engine.db, {
        userId, productionId, kind, before: proposed, after: approved, llmCallId: latestAcceptedCall(this.engine.db, runId, stage),
      });
    } catch (e) {
      this.logger.warn(`could not record the ${gate} approval of ${productionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  /** The gate routes check the role again (a gate key decides it); a Studio admin passes, as with RolesGuard. */
  private requireRole(req: Request, productionId: string, role: TeamRole): void {
    if (req.authContext?.isAdmin) return;
    const row = this.db.get<{ role: TeamRole }>(
      'SELECT tm.role FROM team_members tm JOIN productions p ON p.team_id = tm.team_id WHERE p.id = ? AND tm.user_id = ?',
      [productionId, req.authContext!.userId],
    );
    if (!row || ORDER.indexOf(row.role) < ORDER.indexOf(role)) throw new ForbiddenException(`Requires role: ${role}`);
  }
}
