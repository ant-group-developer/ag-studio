import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { agentToolList, callAgentTool, type ToolAnswer } from '@ag-studio/engine';
import { Public } from '../auth/public.decorator';
import { EngineService } from '../studio/engine.service';
import { WorkspaceService } from '../workspace/workspace.service';
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
  ) {}

  @Get('tools')
  list() {
    return { tools: agentToolList(this.tools.all) };
  }

  /** Body `{name, arguments}`; always 200 with `{text, isError}` — a refusal is something the agent reads. */
  @Post('call')
  @HttpCode(HttpStatus.OK)
  call(@Body() raw: unknown, @Req() req: Request): Promise<ToolAnswer> {
    const body = parseBody(CallSchema, raw);
    const call = req.agentCall!;
    return callAgentTool(this.tools.all, {
      db: this.engine.db, claims: call.claims, message: call.message, thread: call.thread, project: call.project, video: call.video,
      workspaceDir: this.workspace.dir(call.project.id), role: call.role, now: () => new Date().toISOString(),
    }, body.name, body.arguments ?? {});
  }
}
