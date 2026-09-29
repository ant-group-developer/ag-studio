import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  cancelRun,
  readStageDocument,
  retryStage,
  runView,
  startRun,
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
 * The web drives `ag-studio-production@1.0.0` through these routes (plan GĐ4 item 1): start a run, watch
 * it, read the documents each stage produced, submit the three gates, retry or cancel.
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
    return mapErrors(() => startRun(this.engine.core, this.engine.db, id));
  }

  @Get()
  @Roles('viewer')
  status(@Param('id') id: string) {
    return mapErrors(() => runView(this.engine.core, this.engine.db, id));
  }

  /** A JSON document of a stage (brief, catalog, treatment, selection, narration, timeline, export). Text only. */
  @Get('documents/:stage/:name')
  @Roles('viewer')
  document(@Param('id') id: string, @Param('stage') stage: string, @Param('name') name: string) {
    return mapErrors(() => readStageDocument(this.engine.core, this.engine.db, id, stage, name));
  }

  /**
   * Submit a gate. The editor gate (`edit`) needs `editor`; approving the treatment and the shot board are
   * production decisions and need `producer`.
   */
  @Post('gates/:gate')
  @Roles('editor')
  submitGate(@Param('id') id: string, @Param('gate') gate: string, @Body() dto: SubmitGateDto, @Req() req: Request) {
    if (gate in STUDIO_GATES && gate !== 'edit') this.requireRole(req, id, 'producer');
    return mapErrors(async () => {
      const report = await submitStudioGate(this.engine.core, this.engine.db, id, gate, dto.document);
      return { stageState: report.stageState, runState: report.runState };
    });
  }

  @Post('stages/:stage/retry')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('id') id: string, @Param('stage') stage: string) {
    return mapErrors(() => {
      retryStage(this.engine.core, this.engine.db, id, stage);
      return { ok: true };
    });
  }

  @Post('cancel')
  @Roles('producer')
  @HttpCode(HttpStatus.ACCEPTED)
  cancel(@Param('id') id: string) {
    return mapErrors(() => {
      cancelRun(this.engine.core, this.engine.db, id);
      return { ok: true };
    });
  }

  private requireRole(req: Request, productionId: string, role: TeamRole): void {
    const row = this.db.get<{ role: TeamRole }>(
      'SELECT tm.role FROM team_members tm JOIN productions p ON p.team_id = tm.team_id WHERE p.id = ? AND tm.user_id = ?',
      [productionId, req.authContext!.userId],
    );
    if (!row || ORDER.indexOf(row.role) < ORDER.indexOf(role)) throw new ForbiddenException(`Requires role: ${role}`);
  }
}
