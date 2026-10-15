import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { agentToolList, callAgentTool, logAudit, type ToolAnswer } from '@ag-studio/engine';
import { Public } from '../auth/public.decorator';
import { EngineService, referenceFetcherNames } from '../studio/engine.service';
import { WorkspaceService } from '../workspace/workspace.service';
import { ProjectFootageService } from '../workspace/project-footage.service';
import { SiteNameService } from '../ag-go/site-name.service';
import { parseBody } from '../workspace/zod-body';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentToolsService } from './agent-tools.service';

const CallSchema = z.object({ name: z.string().min(1).max(80), arguments: z.unknown().optional() }).strict();

/**
 * The Studio tools, for the MCP server of a running agent turn (spec 2026-10-10 agent-workspace §3.3). Not behind
 * Auth0: the turn's token is the credential (AgentTokenGuard).
 */
@Controller('agent-tools')
@Public()
@UseGuards(AgentTokenGuard)
export class AgentToolsController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly tools: AgentToolsService,
    private readonly footage: ProjectFootageService,
    private readonly siteName: SiteNameService,
  ) {}

  @Get('tools')
  list() {
    return { tools: agentToolList(this.tools.all, { siteName: this.siteName.current() }) };
  }

  /** Body `{name, arguments}`; always 200 with `{text, isError}` — a refusal is something the agent reads. */
  @Post('call')
  @HttpCode(HttpStatus.OK)
  async call(@Body() raw: unknown, @Req() req: Request): Promise<ToolAnswer> {
    const body = parseBody(CallSchema, raw);
    const call = req.agentCall!;
    const started = Date.now();
    // every call goes to the activity log, as the person the turn acts for
    const record = (outcome: 'ok' | 'error', text: string) => logAudit(this.engine.db, {
      actorKind: 'agent', actorId: call.message.created_by, kind: 'tool', action: body.name, outcome, durationMs: Date.now() - started,
      teamId: call.project.team_id, projectId: call.project.id, videoId: call.video?.id ?? null, threadId: call.thread.id, messageId: call.message.id,
      summary: outcome === 'error' ? text.slice(0, 300) : null, details: { args: body.arguments ?? {}, result: text.slice(0, 300) },
    });
    try {
      const answer = await callAgentTool(this.tools.all, {
        db: this.engine.db, claims: call.claims, message: call.message, thread: call.thread, project: call.project, video: call.video,
        workspaceDir: await this.workspace.dir(call.project.id), role: call.role, now: () => new Date().toISOString(), footage: this.footage,
        siteName: this.siteName.current(), referenceFetchers: () => referenceFetcherNames(this.engine),
      }, body.name, body.arguments ?? {});
      await record(answer.isError ? 'error' : 'ok', answer.text);
      return answer;
    } catch (e) {
      await record('error', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}
