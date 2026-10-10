import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AgentTokenGuard } from './agent-token.guard';
import { AgentToolsController } from './agent-tools.controller';
import { AgentToolsService } from './agent-tools.service';

/** The Studio tools a running agent turn calls through its MCP server (spec 2026-10-10 agent-workspace §3.3). */
@Module({
  imports: [StudioModule, WorkspaceModule],
  controllers: [AgentToolsController],
  providers: [AgentTokenGuard, AgentToolsService],
  exports: [AgentToolsService],
})
export class AgentToolsModule {}
