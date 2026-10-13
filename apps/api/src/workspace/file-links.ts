import { Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Query, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import type { Response } from 'express';
import {
  FILE_LINK_TTL_SECONDS, getProject, mimeOf, normalizeRelPath, resolveInside, signFileLink, StudioRunError, verifyFileLink, type FileLinkClaims,
} from '@ag-studio/engine';
import { Public } from '../auth/public.decorator';
import { EngineService } from '../studio/engine.service';
import { WorkspaceService } from './workspace.service';

/**
 * Makes and checks the short links that play a workspace file (`GET projects/:id/files/stream?path&t`). Signed with
 * `STUDIO_AGENT_TOKEN_SECRET` when it is set, so every API process reads every link; without it, with a key of this
 * process only (a link plays where it was made, until a restart).
 */
@Injectable()
export class FileLinkService {
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('STUDIO_AGENT_TOKEN_SECRET') || randomBytes(32).toString('hex');
  }

  /** The path (under the API's `/api`) that plays `path` of the project for 15 minutes, made for `userId`. */
  url(projectId: string, path: string, userId: string, nowMs = Date.now()): string {
    const t = signFileLink({ project: projectId, path, sub: userId, exp: Math.floor(nowMs / 1000) + FILE_LINK_TTL_SECONDS }, this.secret);
    return `/api/projects/${encodeURIComponent(projectId)}/files/stream?path=${encodeURIComponent(path)}&t=${encodeURIComponent(t)}`;
  }

  verify(token: string): FileLinkClaims {
    return verifyFileLink(token, this.secret);
  }

  /** Each file with the link to listen to it. */
  withListenUrls<T extends { path: string }>(projectId: string, files: T[], userId: string): (T & { listenUrl: string })[] {
    const now = Date.now();
    return files.map((f) => ({ ...f, listenUrl: this.url(projectId, f.path, userId, now) }));
  }
}

/**
 * Plays a workspace file to a browser element that cannot send a bearer token (`<audio>`, `<video>`): no login, the
 * signed link instead, for the one file of the one project it names. Served from disk with ranges (206), so a player
 * seeks without reading the whole file.
 */
@Controller('projects/:projectId/files')
export class FileStreamController {
  constructor(
    private readonly engine: EngineService,
    private readonly workspace: WorkspaceService,
    private readonly links: FileLinkService,
  ) {}

  @Get('stream')
  @Public()
  stream(@Param('projectId') projectId: string, @Query('path') path: string, @Query('t') token: string, @Res() res: Response): void {
    let claims: FileLinkClaims;
    try {
      claims = this.links.verify(token);
    } catch (e) {
      if (!(e instanceof StudioRunError)) throw e;
      throw new UnauthorizedException({ code: 'bad_file_link', message: e.message });
    }
    let rel: string;
    try {
      rel = normalizeRelPath(path);
    } catch {
      throw new ForbiddenException({ code: 'bad_scope', message: 'link không dành cho file này' });
    }
    if (claims.project !== projectId || claims.path !== rel) throw new ForbiddenException({ code: 'bad_scope', message: 'link không dành cho file này' });
    const project = getProject(this.engine.db, projectId);
    if (!project || project.archived_at || /^(\.claude|\.git|\.trash)(\/|$)/.test(rel)) throw new NotFoundException({ code: 'not_found', message: `không có file ${rel}` });
    let abs: string;
    try {
      abs = resolveInside(this.workspace.dir(projectId), rel).abs;
    } catch {
      throw new NotFoundException({ code: 'not_found', message: `không có file ${rel}` });
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new NotFoundException({ code: 'not_found', message: `không có file ${rel}` });
    res.sendFile(abs, {
      dotfiles: 'allow', cacheControl: false, lastModified: true,
      headers: { 'Content-Type': mimeOf(rel), 'Cache-Control': `private, max-age=${FILE_LINK_TTL_SECONDS}`, 'X-Content-Type-Options': 'nosniff' },
    }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ code: 'not_found', message: `không có file ${rel}` });
    });
  }
}
