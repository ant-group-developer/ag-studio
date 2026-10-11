import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { auditActors, listAudit, type AuditFilter } from '@ag-studio/engine';
import { AccountDirectoryService, type UserSummary } from '../auth/account-directory.service';
import { StudioAdminService, type ViewScope } from '../auth/studio-admin.service';
import { EngineService } from '../studio/engine.service';
import { parseBody } from '../workspace/zod-body';

/** Someone the Account API does not (or no longer) know. */
const unknownPerson = (userId: string): UserSummary => ({ userId, name: null, email: null, avatar: null });
const iso = z.string().datetime({ offset: true });
const id = z.string().min(1).max(200);
const AuditQuerySchema = z.object({
  teamId: id.optional(),
  projectId: id.optional(),
  videoId: id.optional(),
  threadId: id.optional(),
  actorId: id.optional(),
  actorKind: z.enum(['user', 'agent', 'studio']).optional(),
  kind: z.enum(['http', 'tool', 'turn', 'job']).optional(),
  outcome: z.enum(['ok', 'error']).optional(),
  from: iso.optional(),
  to: iso.optional(),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).strict();

/**
 * The activity log for the people who may read it: a Studio admin reads every row (Studio-wide settings included),
 * a team's owner the rows of the teams they own. A team named in the query narrows it (and must be theirs).
 */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly engine: EngineService,
    private readonly admin: StudioAdminService,
    private readonly directory: AccountDirectoryService,
  ) {}

  /** The teams the log can show this person (for the team filter), and whether they see Studio-wide rows too. */
  @Get('scope')
  async scope(@Req() req: Request) {
    const scope = await this.admin.viewScope(req);
    return { all: scope.all, teams: this.teams(scope) };
  }

  @Get()
  async list(@Query() raw: unknown, @Req() req: Request) {
    const q = parseBody(AuditQuerySchema, raw);
    const scope = await this.admin.viewScope(req, q.teamId);
    const { teamId: _t, page, pageSize, ...rest } = q;
    const filter: AuditFilter = { ...rest, ...(scope.all ? {} : { teamIds: scope.teamIds }) };
    const out = listAudit(this.engine.db, filter, page ?? 1, pageSize ?? 50);
    const people = await this.directory.summaries(out.items.map((i) => i.actorId).filter((x): x is string => !!x));
    return { ...out, items: out.items.map((i) => ({ ...i, actor: i.actorId ? people.get(i.actorId) ?? unknownPerson(i.actorId) : null })) };
  }

  /** Who appears in the log (for the "who" filter). */
  @Get('actors')
  async actors(@Query('teamId') teamId: string | undefined, @Req() req: Request) {
    const scope = await this.admin.viewScope(req, teamId || undefined);
    const ids = auditActors(this.engine.db, scope.all ? {} : { teamIds: scope.teamIds });
    const people = await this.directory.summaries(ids);
    return { actors: ids.map((i) => people.get(i) ?? unknownPerson(i)) };
  }

  private teams(scope: ViewScope): { id: string; name: string }[] {
    if (scope.all) return this.engine.db.all<{ id: string; name: string }>('SELECT id, name FROM teams ORDER BY name');
    if (!scope.teamIds.length) return [];
    return this.engine.db.all<{ id: string; name: string }>(
      `SELECT id, name FROM teams WHERE id IN (${scope.teamIds.map(() => '?').join(', ')}) ORDER BY name`, scope.teamIds,
    );
  }
}
