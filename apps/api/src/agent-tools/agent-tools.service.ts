import { Injectable } from '@nestjs/common';
import { agentTools, type AgentTool } from '@ag-studio/engine';

/** The tools this API offers an agent turn (the engine's, with the API's own dependencies as phases add them). */
@Injectable()
export class AgentToolsService {
  readonly all: AgentTool[] = agentTools();
}
