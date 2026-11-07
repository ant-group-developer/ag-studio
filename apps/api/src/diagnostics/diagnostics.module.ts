import { Module } from '@nestjs/common';
import { StudioModule } from '../studio/studio.module';
import { WorkspaceModule } from '../workspace/workspace.module';
import { DiagnosticsController } from './diagnostics.controller';

/** The admin's diagnostics of a period (plan 2026-11-07 prod-diagnostics). */
@Module({
  imports: [StudioModule, WorkspaceModule],
  controllers: [DiagnosticsController],
})
export class DiagnosticsModule {}
