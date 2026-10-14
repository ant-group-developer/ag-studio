/**
 * Chat threads over a real studio.db: a project starts with its "Kênh" thread, a video gets its own thread (with the
 * first message when given), sending queues a turn for the worker, a stop cancels it, a thread learns from earlier
 * ones, and the event streams carry the changed messages.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, take, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { markAgentTurnRunning, updateRunningTurn } from '@ag-studio/engine';
import { insertTeam, NO_DIRECTORY, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { ProjectsController } from './projects.controller';
import { ThreadsController } from './threads.controller';
import { VideosController } from './videos.controller';
import { WorkspaceService } from './workspace.service';

const req = (userId: string, isAdmin = false) => ({ authContext: { userId, accessToken: 't', isAdmin } }) as unknown as Request;
const OWNER = 'auth0|owner';

describe('threads (real studio.db)', () => {
  let s: RealStudio;
  let projects: ProjectsController;
  let videos: VideosController;
  let threads: ThreadsController;

  beforeEach(async () => {
    s = await realStudio();
    const engine = s.engine as unknown as EngineService;
    const ws = new WorkspaceService({ get: (k: string, d?: unknown) => (k === 'STUDIO_WORKSPACES_ROOT' ? mkdtempSync(join(tmpdir(), 'thr-')) : d) } as unknown as ConfigService, engine);
    projects = new ProjectsController(engine, ws, NO_DIRECTORY);
    videos = new VideosController(engine, ws);
    threads = new ThreadsController(engine);
    insertTeam(s.db, 'team-1', OWNER);
    s.db.run("INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ('team-1', 'auth0|ed', 'editor', ?)", [new Date().toISOString()]);
  });
  afterEach(() => s.close());

  it('a project starts with its channel thread; sending queues one turn that answers every message sent before it starts', async () => {
    const p = await projects.create('team-1', { name: 'Kênh A' }, req(OWNER));
    const [kenh] = (await threads.list(p.id)).threads;
    expect(kenh).toMatchObject({ kind: 'project', title: 'Kênh', useLessons: true });
    const first = await threads.send(kenh!.id, { text: 'Nghiên cứu kênh', attachments: ['context\\notes.md'] }, req('auth0|ed'));
    expect(first.message).toMatchObject({ role: 'user', attachments: ['context/notes.md'], actorRole: 'editor' });
    expect(first.turn).toMatchObject({ role: 'assistant', status: 'pending', actorRole: 'editor' });
    const second = await threads.send(kenh!.id, { text: 'Thêm xu hướng' }, req(OWNER, true));
    expect(second.turn).toMatchObject({ actorRole: 'owner' });
    const thread = await threads.get(kenh!.id);
    expect(thread.messages.map((m) => [m.role, m.status])).toEqual([['user', 'done'], ['user', 'done'], ['assistant', 'pending']]);
    expect((await threads.activity(p.id)).activity).toMatchObject([{ kind: 'agent_turn', status: 'waiting', threadTitle: 'Kênh' }]);
    const stopped = await threads.cancel(kenh!.id, second.turn!.id);
    expect(stopped.status).toBe('cancelled');
  });

  it('a new video gets its own thread with the first message, and learns from what was chosen', async () => {
    const p = await projects.create('team-1', { name: 'Kênh A' }, req(OWNER));
    const old = await threads.create(p.id, { title: 'Ý tưởng cũ' }, req(OWNER));
    const v = await videos.create(p.id, {
      prompt: 'Video Hội An ban đêm, 6 phút', learning: { useLessons: false, threads: [{ threadId: old.id, mode: 'full' }] },
    }, req('auth0|ed'));
    const t = await threads.get(v.threadId);
    expect(t).toMatchObject({ kind: 'video', videoId: v.id, useLessons: false, refs: [{ threadId: old.id, mode: 'full', title: 'Ý tưởng cũ' }] });
    expect(t.messages.map((m) => m.text)).toEqual(['Video Hội An ban đêm, 6 phút', '']);
    expect((await videos.get(v.id, req(OWNER))).threadId).toBe(v.threadId);
    const relearn = await threads.setLearning(v.threadId, { useLessons: true, threads: [] }, req(OWNER));
    expect(relearn.useLessons).toBe(true);
    expect((await threads.get(v.threadId)).refs).toEqual([]);
  });

  it('streams the messages of a running turn as they change', async () => {
    const p = await projects.create('team-1', { name: 'Kênh A' }, req(OWNER));
    const [kenh] = (await threads.list(p.id)).threads;
    const sent = await threads.send(kenh!.id, { text: 'Chào' }, req(OWNER));
    const first = await firstValueFrom(threads.threadEvents(kenh!.id));
    expect(first.type).toBe('messages');
    expect((first.data as { messages: unknown[] }).messages).toHaveLength(2);
    const stream = threads.threadEvents(kenh!.id).pipe(take(2), toArray());
    const pending = firstValueFrom(stream);
    markAgentTurnRunning(s.engine.db, sent.turn!.id, new Date(Date.now() + 5).toISOString());
    setTimeout(() => updateRunningTurn(s.engine.db, sent.turn!.id, { text: 'Xin', parts: [{ kind: 'text', text: 'Xin' }], phase: { kind: 'writing' } }, new Date(Date.now() + 10).toISOString()), 50);
    const [, update] = await pending;
    expect((update!.data as { messages: { text: string; phase: unknown }[] }).messages.at(-1)).toMatchObject({ text: 'Xin', phase: { kind: 'writing' } });
  });
});
