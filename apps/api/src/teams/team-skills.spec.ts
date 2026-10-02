/**
 * Team skills routes over a real studio.db: list/create/update/delete with the engine's limits mapped to HTTP, the
 * body DTOs, and the single-team route the team page reads its name and the caller's role from.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { insertTeam, realStudio, type RealStudio } from '../test/real-studio';
import type { EngineService } from '../studio/engine.service';
import { CreateTeamSkillDto, UpdateTeamSkillDto } from './dto/team-skill.dto';
import { TeamSkillsController } from './team-skills.controller';
import { TeamsService } from './teams.service';

const req = (userId: string, isAdmin = false) => ({ authContext: { userId, isAdmin } }) as unknown as Request;

async function problems<T extends object>(cls: new () => T, body: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((e) => e.property);
}

describe('team skills routes (real studio.db)', () => {
  let s: RealStudio;
  let ctl: TeamSkillsController;
  beforeEach(async () => {
    s = await realStudio();
    insertTeam(s.db, 'team-1', 'auth0|owner');
    ctl = new TeamSkillsController(s.engine as EngineService);
  });
  afterEach(() => s.close());

  it('creates, lists in order, updates and deletes, in camelCase', async () => {
    const a = await ctl.create('team-1', { name: 'Tiêu đề', content: '- ≤ 60 ký tự', position: 2 }, req('auth0|owner'));
    const b = await ctl.create('team-1', { name: 'Mục đích', purpose: 'Vì sao', content: 'Kể chuyện', appliesTo: ['branding', 'rnd'], position: 1 }, req('auth0|owner'));
    expect(b).toMatchObject({ teamId: 'team-1', name: 'Mục đích', appliesTo: ['rnd', 'branding'], enabled: true, createdBy: 'auth0|owner' });
    expect((await ctl.list('team-1')).map((x) => x.name)).toEqual(['Mục đích', 'Tiêu đề']);

    const u = await ctl.update('team-1', a.id, { enabled: false }, req('auth0|producer'));
    expect(u).toMatchObject({ enabled: false, updatedBy: 'auth0|producer' });

    await ctl.remove('team-1', a.id);
    expect((await ctl.list('team-1')).map((x) => x.id)).toEqual([b.id]);
  });

  it('answers 409 for a taken name, 422 past the length limits and 404 for a skill of another team', async () => {
    await ctl.create('team-1', { name: 'A', content: 'a' }, req('u'));
    await expect(ctl.create('team-1', { name: 'A', content: 'b' }, req('u'))).rejects.toBeInstanceOf(ConflictException);
    const big = 'x'.repeat(20_000);
    await ctl.create('team-1', { name: 'B', content: big }, req('u'));
    await ctl.create('team-1', { name: 'C', content: big }, req('u'));
    await expect(ctl.create('team-1', { name: 'D', content: big }, req('u'))).rejects.toBeInstanceOf(UnprocessableEntityException);
    insertTeam(s.db, 'team-2', 'auth0|other');
    const other = await ctl.create('team-2', { name: 'X', content: 'x' }, req('u'));
    await expect(ctl.update('team-1', other.id, { name: 'Y' }, req('u'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.list('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('validates the bodies', async () => {
    expect(await problems(CreateTeamSkillDto, { name: 'A', content: 'x' })).toEqual([]);
    expect(await problems(CreateTeamSkillDto, { name: '', content: 'x' })).toEqual(['name']);
    expect(await problems(CreateTeamSkillDto, { name: 'A', content: 'x', appliesTo: ['render'] })).toEqual(['appliesTo']);
    expect(await problems(CreateTeamSkillDto, { name: 'A', content: 'x'.repeat(20_001) })).toEqual(['content']);
    expect(await problems(UpdateTeamSkillDto, { enabled: true })).toEqual([]);
    expect(await problems(UpdateTeamSkillDto, { teamId: 'team-2' })).toEqual(['teamId']);
  });

  it('shows one team with the caller role; an admin who is not a member gets role null', () => {
    const teams = new TeamsService(s.db, s.engine);
    expect(teams.getTeam('team-1', 'auth0|owner')).toMatchObject({ id: 'team-1', name: 'Team team-1', role: 'owner', memberCount: 1, productionCount: 0 });
    expect(teams.getTeam('team-1', 'auth0|admin').role).toBeNull();
    expect(() => teams.getTeam('missing', 'auth0|owner')).toThrow(NotFoundException);
  });
});
