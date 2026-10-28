import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { StudioDbService } from '../db/studio-db.service';

/** The getting started steps, in the order the checklist shows them. */
export const ONBOARDING_STEPS = ['team', 'project', 'footage', 'video', 'chat', 'preview', 'final'] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingProgress {
  steps: { key: OnboardingStepKey; done: boolean; count: number }[];
  done: number;
  total: number;
  /** Where "Go to" leads: the team and project worked in last, the video touched last. */
  links: { teamId: string | null; projectId: string | null; video: { projectId: string; videoId: string } | null };
}

export interface UserPrefs {
  tourSeen: { projects: boolean; project: boolean };
  checklistHidden: boolean;
}

/** A change to the prefs: only the fields given change. */
export const UserPrefsPatchSchema = z.object({
  tourSeen: z.object({ projects: z.boolean().optional(), project: z.boolean().optional() }).strict().optional(),
  checklistHidden: z.boolean().optional(),
}).strict();
export type UserPrefsPatch = z.infer<typeof UserPrefsPatchSchema>;

/** Prefs as stored, read leniently: an unknown or broken value falls back to the default. */
function readPrefs(raw: unknown): UserPrefs {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const seen = (v.tourSeen && typeof v.tourSeen === 'object' ? v.tourSeen : {}) as Record<string, unknown>;
  return {
    tourSeen: { projects: seen.projects === true, project: seen.project === true },
    checklistHidden: v.checklistHidden === true,
  };
}

/**
 * The person's getting started progress (counted across the teams they are in) and their own UI prefs (tours seen,
 * checklist hidden).
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: StudioDbService) {}

  async progress(userId: string): Promise<OnboardingProgress> {
    const row = await this.db.get<Record<OnboardingStepKey, number>>(
      `WITH mine AS (SELECT p.id FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
                      WHERE tm.user_id = ? AND p.archived_at IS NULL)
       SELECT
         (SELECT COUNT(*) FROM team_members WHERE user_id = ?) AS team,
         (SELECT COUNT(*) FROM mine) AS project,
         (SELECT COUNT(*) FROM project_sources WHERE project_id IN (SELECT id FROM mine) AND kind IN ('ag_go_project', 'ag_go_asset', 'upload_asset')) AS footage,
         (SELECT COUNT(*) FROM videos WHERE project_id IN (SELECT id FROM mine) AND archived_at IS NULL) AS video,
         (SELECT COUNT(*) FROM agent_messages m JOIN agent_threads t ON t.id = m.thread_id
           WHERE t.project_id IN (SELECT id FROM mine) AND m.role = 'user' AND m.created_by = ?) AS chat,
         (SELECT COUNT(*) FROM project_jobs WHERE project_id IN (SELECT id FROM mine) AND kind = 'render_preview' AND status = 'done') AS preview,
         (SELECT COUNT(*) FROM project_jobs WHERE project_id IN (SELECT id FROM mine) AND kind = 'render_final' AND status = 'done') AS final`,
      [userId, userId, userId],
    ) ?? ({} as Record<OnboardingStepKey, number>);
    const steps = ONBOARDING_STEPS.map((key) => ({ key, count: Number(row[key] ?? 0), done: Number(row[key] ?? 0) > 0 }));

    const project = await this.db.get<{ id: string; team_id: string }>(
      `SELECT p.id, p.team_id FROM projects p JOIN team_members tm ON tm.team_id = p.team_id
        WHERE tm.user_id = ? AND p.archived_at IS NULL ORDER BY p.updated_at DESC, p.id LIMIT 1`,
      [userId],
    );
    const team = project?.team_id
      ?? (await this.db.get<{ team_id: string }>('SELECT team_id FROM team_members WHERE user_id = ? ORDER BY joined_at DESC LIMIT 1', [userId]))?.team_id
      ?? null;
    const video = await this.db.get<{ id: string; project_id: string }>(
      `SELECT v.id, v.project_id FROM videos v JOIN projects p ON p.id = v.project_id JOIN team_members tm ON tm.team_id = p.team_id
        WHERE tm.user_id = ? AND p.archived_at IS NULL AND v.archived_at IS NULL ORDER BY v.updated_at DESC, v.id LIMIT 1`,
      [userId],
    );
    return {
      steps,
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      links: { teamId: team, projectId: project?.id ?? null, video: video ? { projectId: video.project_id, videoId: video.id } : null },
    };
  }

  async prefs(userId: string): Promise<UserPrefs> {
    return readPrefs((await this.db.get<{ prefs: unknown }>('SELECT prefs FROM user_prefs WHERE user_id = ?', [userId]))?.prefs);
  }

  updatePrefs(userId: string, patch: UserPrefsPatch): Promise<UserPrefs> {
    return this.db.tx(async () => {
      const current = await this.prefs(userId);
      const next: UserPrefs = {
        tourSeen: { ...current.tourSeen, ...(patch.tourSeen ?? {}) },
        checklistHidden: patch.checklistHidden ?? current.checklistHidden,
      };
      await this.db.run(
        `INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(next), new Date().toISOString()],
      );
      return next;
    });
  }
}
