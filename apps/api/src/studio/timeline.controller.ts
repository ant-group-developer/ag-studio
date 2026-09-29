import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  audioUrl,
  getRevision,
  latestRevision,
  listRevisions,
  pollEditorJob,
  readStageDocument,
  saveTimeline,
  startLineTts,
  startPreview,
  timelineIssues,
  type TimelineIssue,
  type TimelineRevision,
} from '@ag-studio/engine';

import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LineTtsDto, PreviewDto, SaveRevisionDto } from './dto';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

/**
 * Web editor M1 (plan 4.2): timeline revisions (autosave with `baseRevision`, 409 on conflict), re-TTS of one
 * line, render preview, narration audio and the exported files.
 */
@Controller('productions/:id')
@UseGuards(RolesGuard)
export class TimelineController {
  constructor(
    private readonly engine: EngineService,
    private readonly access: FootageAccessService,
  ) {}

  @Get('timeline')
  @Roles('viewer')
  latest(@Param('id') id: string): TimelineRevision & { issues: TimelineIssue[] } {
    const rev = latestRevision(this.engine.db, id);
    if (!rev) throw new NotFoundException({ message: 'no timeline revision yet', code: 'not_found' });
    return { ...rev, issues: timelineIssues(rev.data) };
  }

  @Get('timeline/revisions')
  @Roles('viewer')
  revisions(@Param('id') id: string) {
    return listRevisions(this.engine.db, id);
  }

  @Get('timeline/revisions/:rev')
  @Roles('viewer')
  revision(@Param('id') id: string, @Param('rev', ParseIntPipe) rev: number): TimelineRevision & { issues: TimelineIssue[] } {
    const r = getRevision(this.engine.db, id, rev);
    if (!r) throw new NotFoundException({ message: `revision ${rev} not found`, code: 'not_found' });
    return { ...r, issues: timelineIssues(r.data) };
  }

  /** Autosave. 201 `{ revision, issues }`; 409 `{ currentRevision }` when `baseRevision` is not the latest. */
  @Post('timeline/revisions')
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  save(@Param('id') id: string, @Body() dto: SaveRevisionDto, @Req() req: Request): Promise<{ revision: number; issues: TimelineIssue[] }> {
    return mapErrors(() =>
      saveTimeline(this.engine.db, id, { baseRevision: dto.baseRevision, data: dto.data, authorId: req.authContext!.userId, label: dto.label ?? 'autosave' }),
    );
  }

  /** One edited sentence -> one TTS job. Poll `editor/jobs/:jobId`, then save a revision with the new audio. */
  @Post('editor/tts')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  tts(@Param('id') id: string, @Body() dto: LineTtsDto, @Req() req: Request) {
    return mapErrors(() => startLineTts(this.engine.editor, { productionId: id, lineId: dto.lineId, text: dto.text, userId: req.authContext!.userId }));
  }

  @Post('editor/previews')
  @Roles('editor')
  @HttpCode(HttpStatus.ACCEPTED)
  preview(@Param('id') id: string, @Body() dto: PreviewDto, @Req() req: Request) {
    return mapErrors(() => startPreview(this.engine.editor, { productionId: id, revision: dto.revision, userId: req.authContext!.userId }));
  }

  /** A preview's video URL is handed out only to members whose own footage scope covers the production. */
  @Get('editor/jobs/:jobId')
  @Roles('viewer')
  job(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: Request) {
    return mapErrors(async () => {
      const job = await pollEditorJob(this.engine.editor, id, jobId, { urlTtlSeconds: this.engine.browserUrlTtl });
      if (job.url && !(await this.access.coversProduction(req.authContext!.userId, id))) {
        const { url: _hidden, ...rest } = job;
        return { ...rest, urlHidden: 'footage_scope' };
      }
      return job;
    });
  }

  /** Narration audio carries no footage: every member may listen. */
  @Get('audio')
  @Roles('viewer')
  audio(@Param('id') id: string, @Query('key') key: string) {
    return mapErrors(async () => ({ url: await audioUrl(this.engine.bucket, id, key, this.engine.browserUrlTtl) }));
  }

  /** The export of the current run: SRT/VTT for every member, the MP4 only within footage scope. */
  @Get('exports')
  @Roles('viewer')
  exports(@Param('id') id: string, @Req() req: Request) {
    return mapErrors(async () => {
      const exp = readStageDocument(this.engine.core, this.engine.db, id, 'export', 'export.json') as {
        files: { kind: string; key: string; size_bytes: number }[];
        duration_seconds: number;
        watermarked: boolean;
      };
      const covered = await this.access.coversProduction(req.authContext!.userId, id);
      const files = await Promise.all(
        exp.files.map(async (f) => {
          const allowed = f.kind !== 'mp4' || covered;
          return {
            kind: f.kind,
            name: f.key.split('/').pop(),
            sizeBytes: f.size_bytes,
            url: allowed ? await this.engine.bucket.signedGetUrl(f.key, this.engine.browserUrlTtl) : null,
            ...(allowed ? {} : { urlHidden: 'footage_scope' }),
          };
        }),
      );
      return { durationSeconds: exp.duration_seconds, watermarked: exp.watermarked, files };
    });
  }
}
