import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenException, HttpCode, HttpStatus, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { defer, lastValueFrom, of, throwError } from 'rxjs';
import { createProject, listAudit } from '@ag-studio/engine';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { AuditInterceptor, NoAudit } from './audit.interceptor';

class ProjectsController {
  @HttpCode(HttpStatus.CREATED) create() {}
  update() {}
  remove() {}
  list() {}
  @NoAudit() estimate() {}
}

function ctx(req: Partial<Request>, handler: keyof ProjectsController): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    getClass: () => ProjectsController,
    getHandler: () => ProjectsController.prototype[handler],
  } as unknown as ExecutionContext;
}
const answer = (v: unknown): CallHandler => ({ handle: () => of(v) });
const fail = (e: unknown): CallHandler => ({ handle: () => throwError(() => e) });
const user = { userId: 'auth0|owner', accessToken: 't' };

describe('AuditInterceptor (real database)', () => {
  let s: RealStudio;
  let audit: AuditInterceptor;
  beforeEach(async () => {
    s = await realStudio();
    await insertTeam(s.db, 'team-1', 'auth0|owner');
    audit = new AuditInterceptor(s.engine as EngineService, new Reflector());
  });
  afterEach(() => s.close());

  it('records a write with its route, handler, team, safe body fields and the new id; not chat text', async () => {
    const req = {
      method: 'POST', authContext: user, params: { teamId: 'team-1' }, route: { path: '/api/teams/:teamId/projects' }, path: '/api/teams/team-1/projects',
      body: { name: 'Kênh A', description: 'mô tả dài', text: 'tin nhắn riêng', accessToken: 'secret' }, requestId: 'req-1',
    } as unknown as Request;
    const p = await createProject(s.engine.db, 'team-1', { name: 'Kênh A', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    await lastValueFrom(audit.intercept(ctx(req, 'create'), answer({ success: true, requestId: 'r', data: { id: p.id } })));
    await audit.settled();
    const [row] = (await listAudit(s.engine.db, {})).items;
    expect(row).toMatchObject({
      actorKind: 'user', actorId: 'auth0|owner', kind: 'http', action: 'ProjectsController.create', outcome: 'ok', method: 'POST',
      route: '/api/teams/:teamId/projects', statusCode: 201, team: { id: 'team-1' }, project: { id: p.id, name: 'Kênh A' }, target: 'Kênh A',
    });
    expect(row!.details).toEqual({ params: { teamId: 'team-1' }, body: { name: 'Kênh A', descriptionSize: 9, textSize: 14 }, created: p.id });
    expect(JSON.stringify(row)).not.toContain('tin nhắn riêng');
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('a delete still knows the team of what it removed', async () => {
    const p = await createProject(s.engine.db, 'team-1', { name: 'Kênh B', description: '', language: 'vi', aspect: '16:9' }, 'auth0|owner');
    const req = { method: 'DELETE', authContext: user, params: { projectId: p.id }, route: { path: '/api/projects/:projectId' }, body: {} } as unknown as Request;
    const out = audit.intercept(ctx(req, 'remove'), { handle: () => defer(async () => { await s.engine.db.run('DELETE FROM projects WHERE id = ?', [p.id]); }) });
    await lastValueFrom(out, { defaultValue: undefined });
    await audit.settled();
    expect((await listAudit(s.engine.db, { teamIds: ['team-1'] })).items[0]).toMatchObject({ action: 'ProjectsController.remove', statusCode: 200, team: { id: 'team-1' } });
  });

  it('records a refusal with its status and passes the error on', async () => {
    const req = { method: 'PATCH', authContext: user, params: {}, route: { path: '/api/x' }, body: {} } as unknown as Request;
    await expect(lastValueFrom(audit.intercept(ctx(req, 'update'), fail(new ForbiddenException({ code: 'nope', message: 'Không được' }))))).rejects.toBeInstanceOf(ForbiddenException);
    await audit.settled();
    expect((await listAudit(s.engine.db, {})).items[0]).toMatchObject({ outcome: 'error', statusCode: 403, summary: 'Không được', details: { error: 'nope' } });
  });

  it('leaves reads, anonymous calls and routes marked NoAudit out', async () => {
    await lastValueFrom(audit.intercept(ctx({ method: 'GET', authContext: user, params: {} } as unknown as Request, 'list'), answer([])));
    await lastValueFrom(audit.intercept(ctx({ method: 'POST', params: {} } as unknown as Request, 'create'), answer({})));
    await lastValueFrom(audit.intercept(ctx({ method: 'POST', authContext: user, params: {} } as unknown as Request, 'estimate'), answer({})));
    await audit.settled();
    expect((await listAudit(s.engine.db, {})).total).toBe(0);
  });

  it('a failure to write the log is reported, never thrown, and the answer still goes out', async () => {
    const req = { method: 'PATCH', authContext: user, params: {}, route: { path: '/api/x' }, body: {} } as unknown as Request;
    await s.close();
    await expect(lastValueFrom(audit.intercept(ctx(req, 'update'), answer({ ok: true })))).resolves.toEqual({ ok: true });
    await audit.settled();
  });
});
