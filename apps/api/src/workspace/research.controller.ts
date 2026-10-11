import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CrawlRequestSchema, crawlTitle, estimateCrawlUnits, isLargeCrawl, jobView, queueResearch, requireProject, type ActorRole, type CrawlRequest,
  type JobView,
} from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EngineService } from '../studio/engine.service';
import { mapErrors } from '../studio/http-errors';
import { WorkspaceService } from './workspace.service';
import { parseBody } from './zod-body';

export interface CrawlEstimate {
  request: CrawlRequest;
  title: string;
  /** YouTube Data API units at most (none with yt-dlp). */
  units: number;
  large: boolean;
  source: 'youtube_api' | 'yt-dlp';
}

export interface ResearchFile {
  path: string;
  title: string;
  modifiedAt: string;
  size: number;
  /** A crawl Studio wrote (with its `.json`), or a document someone wrote. */
  crawl: { kind: CrawlRequest['kind']; fetchedAt: string; source: string; videos: number; channels: number; quotaUnits: number } | null;
}

const RunSchema = z.object({ crawl: z.unknown(), threadId: z.string().min(1).optional() }).strict();

/**
 * The Research tab (spec 2026-10-10 agent-workspace §P5): what a crawl costs before it runs, running it (a background
 * job writing research/<date>-<slug>.{md,json}), and the research documents of the project. A person may run large
 * crawls here; the agent may not.
 */
@Controller('projects/:projectId/research')
@UseGuards(RolesGuard)
export class ResearchController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly config: ConfigService,
  ) {}

  @Post('estimate')
  @Roles('viewer')
  @HttpCode(HttpStatus.OK)
  estimate(@Param('projectId') projectId: string, @Body() raw: unknown): Promise<CrawlEstimate> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      const request = parseBody(CrawlRequestSchema, raw);
      const api = !!this.config.get<string>('YOUTUBE_API_KEY');
      return { request, title: crawlTitle(request), units: api ? estimateCrawlUnits(request) : 0, large: isLargeCrawl(request), source: api ? 'youtube_api' : 'yt-dlp' };
    });
  }

  @Post()
  @Roles('editor')
  @HttpCode(HttpStatus.CREATED)
  run(@Param('projectId') projectId: string, @Body() raw: unknown, @Req() req: Request): Promise<JobView> {
    return mapErrors(() => {
      const body = parseBody(RunSchema, raw);
      const crawl = parseBody(CrawlRequestSchema, body.crawl);
      const project = requireProject(this.engine.db, projectId);
      const threadId = body.threadId && this.engine.db.get<{ id: string }>('SELECT id FROM agent_threads WHERE id = ? AND project_id = ?', [body.threadId, projectId]) ? body.threadId : null;
      const role = req.authContext?.isAdmin ? 'owner'
        : this.engine.db.get<{ role: ActorRole }>('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?', [project.team_id, req.authContext!.userId])?.role ?? null;
      return jobView(queueResearch(this.engine.db, { projectId, crawl, threadId, createdBy: req.authContext!.userId, actorRole: role }));
    });
  }

  /** `research/*.md` newest first, with what Studio knows of the crawls among them. */
  @Get()
  @Roles('viewer')
  list(@Param('projectId') projectId: string): Promise<{ files: ResearchFile[] }> {
    return mapErrors(() => {
      requireProject(this.engine.db, projectId);
      const dir = join(this.workspace.dir(projectId), 'research');
      if (!existsSync(dir)) return { files: [] };
      const files: ResearchFile[] = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (!st.isFile()) continue;
        const text = readFileSync(abs, 'utf8');
        const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name.replace(/\.md$/, '');
        files.push({ path: `research/${name}`, title, modifiedAt: st.mtime.toISOString(), size: st.size, crawl: crawlOf(join(dir, name.replace(/\.md$/, '.json'))) });
      }
      return { files: files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)) };
    });
  }
}

function crawlOf(jsonPath: string): ResearchFile['crawl'] {
  if (!existsSync(jsonPath)) return null;
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8')) as { schema_version?: string; request?: { kind?: string }; fetched_at?: string; source?: string; videos?: unknown[]; channels?: unknown[]; quota_units?: number };
    if (j.schema_version !== 'studio.crawl/v1' || !j.request?.kind) return null;
    return {
      kind: j.request.kind as CrawlRequest['kind'], fetchedAt: j.fetched_at ?? '', source: j.source ?? '', videos: j.videos?.length ?? 0,
      channels: j.channels?.length ?? 0, quotaUnits: j.quota_units ?? 0,
    };
  } catch {
    return null;
  }
}
