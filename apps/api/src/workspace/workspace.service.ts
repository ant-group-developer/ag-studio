import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDir, requireProject, seedWorkspace } from '@ag-studio/engine';
import { EngineService } from '../studio/engine.service';

/**
 * Where project workspaces live (spec 2026-10-10 agent-workspace §3.1): `STUDIO_WORKSPACES_ROOT`, else
 * `<STUDIO_DATA_ROOT>/workspaces`. The worker reads the same folder, so both must point at one disk.
 */
@Injectable()
export class WorkspaceService {
  readonly root: string;

  constructor(
    config: ConfigService,
    private readonly engine: EngineService,
  ) {
    const explicit = config.get<string>('STUDIO_WORKSPACES_ROOT');
    this.root = resolve(explicit ?? join(config.get<string>('STUDIO_DATA_ROOT', './data/harness'), 'workspaces'));
    mkdirSync(this.root, { recursive: true });
  }

  /** The project's folder; re-seeded when missing (a fresh disk, or a project made before the folder existed). */
  dir(projectId: string): string {
    const dir = projectDir(this.root, projectId);
    if (!existsSync(dir)) seedWorkspace(this.root, requireProject(this.engine.db, projectId));
    return dir;
  }
}
