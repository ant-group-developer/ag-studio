import { Injectable, NotFoundException } from '@nestjs/common';
import { StudioDbService } from '../db/studio-db.service';
import type { BriefFieldsDto } from './dto/brief-fields.dto';

interface ProductionRow {
  id: string;
  team_id: string;
  title: string;
  status: string;
  canvas: string | null;
  brief: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
  owner_user_id: string | null;
  aspect: string | null;
  language: string | null;
  music: string | null;
  goal: string | null;
  audience: string | null;
  tone: string | null;
  notes: string | null;
  youtube_channels: string | null;
  keywords: string | null;
  episode_target_seconds: number | null;
  max_episodes: number | null;
}

interface ProductionSourceRow {
  source_id: string;
}

interface EpisodeRow {
  status: string;
  run_id: string | null;
}

interface RunRow {
  state: string;
  waiting_gate: string | null;
}

interface TeamRow {
  name: string;
}

export type ProductionStatus =
  | 'draft' | 'planning' | 'waiting_approval'
  | 'producing' | 'done' | 'failed' | 'archived';

export interface EpisodeCounts {
  total: number;
  ready: number;
  producing: number;
  failed: number;
}

export interface ProductionDto {
  id: string;
  teamId: string;
  teamName: string;
  title: string;
  description: string;
  goal: string;
  audience: string;
  tone: string;
  notes: string;
  sources: string[];
  youtubeChannels: string[];
  keywords: string[];
  episodeTargetSeconds: number | null;
  maxEpisodes: number;
  aspect: '16:9' | '9:16';
  language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  canvas: { width: number; height: number } | null;
  status: ProductionStatus;
  runId: string | null;
  episodeCounts: EpisodeCounts;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function musicToDb(m: BriefFieldsDto['music']): string | null {
  return m ? JSON.stringify({ track: m.track, gain_db: m.gainDb, ducking: m.ducking }) : null;
}

function parseMusic(raw: string | null): { track: string; gainDb: number; ducking: boolean } | null {
  if (!raw) return null;
  const m = JSON.parse(raw) as { track: string; gain_db: number; ducking: boolean };
  return { track: m.track, gainDb: m.gain_db, ducking: m.ducking };
}

/**
 * Derive ProductionStatus from the plan run state, waiting gate, and episode states.
 * The DB status column is only used for 'archived'.
 */
function deriveStatus(
  row: ProductionRow,
  run: RunRow | null,
  episodes: EpisodeRow[],
): ProductionStatus {
  if (row.status === 'archived') return 'archived';
  if (!run) return 'draft';

  const runState = run.state;
  if (runState === 'WAITING') {
    if (run.waiting_gate === 'approve-plan') return 'waiting_approval';
  }
  if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(runState)) {
    // run is actively going (RUNNING, WAITING for non-approve-plan gate, etc.)
    return 'planning';
  }

  // Run is terminal — look at episodes
  if (episodes.length === 0) {
    if (runState === 'FAILED' || runState === 'CANCELLED') return 'failed';
    return 'planning'; // ran but no episodes yet
  }

  const hasProducing = episodes.some((e) => e.status === 'producing' || e.status === 'in_progress');
  if (hasProducing) return 'producing';

  const hasFailed = episodes.some((e) => e.status === 'failed');
  const allReady = episodes.every((e) => e.status === 'succeeded');

  if (allReady) return 'done';
  if (hasFailed) return 'failed';
  return 'producing'; // some still pending/in_progress
}

function countEpisodes(episodes: EpisodeRow[]): EpisodeCounts {
  return {
    total: episodes.length,
    ready: episodes.filter((e) => e.status === 'succeeded').length,
    producing: episodes.filter((e) => e.status === 'producing' || e.status === 'in_progress').length,
    failed: episodes.filter((e) => e.status === 'failed').length,
  };
}

@Injectable()
export class ProductionsService {
  constructor(private readonly db: StudioDbService) {}

  private rowToDto(
    row: ProductionRow,
    sources: string[],
    run: RunRow | null,
    episodes: EpisodeRow[],
    teamName: string,
  ): ProductionDto {
    return {
      id: row.id,
      teamId: row.team_id,
      teamName,
      title: row.title,
      description: row.brief ?? '',
      goal: row.goal ?? '',
      audience: row.audience ?? '',
      tone: row.tone ?? '',
      notes: row.notes ?? '',
      sources,
      youtubeChannels: row.youtube_channels ? (JSON.parse(row.youtube_channels) as string[]) : [],
      keywords: row.keywords ? (JSON.parse(row.keywords) as string[]) : [],
      episodeTargetSeconds: row.episode_target_seconds,
      maxEpisodes: row.max_episodes ?? 10,
      aspect: (row.aspect ?? '16:9') as '16:9' | '9:16',
      language: row.language ?? 'vi',
      music: parseMusic(row.music),
      canvas: row.canvas ? (JSON.parse(row.canvas) as { width: number; height: number }) : null,
      status: deriveStatus(row, run, episodes),
      runId: row.run_id,
      episodeCounts: countEpisodes(episodes),
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private loadRunAndEpisodes(id: string, runId: string | null): { run: RunRow | null; episodes: EpisodeRow[] } {
    const run = runId
      ? (this.db.get<RunRow>(
          `SELECT r.state,
            (SELECT s.key FROM stage_runs s WHERE s.run_id = r.run_id AND s.state = 'WAITING_HUMAN' LIMIT 1) AS waiting_gate
           FROM runs r WHERE r.run_id = ?`,
          [runId],
        ) ?? null)
      : null;
    const episodes = this.db.all<EpisodeRow>(
      'SELECT status, run_id FROM episodes WHERE production_id = ?',
      [id],
    );
    return { run, episodes };
  }

  private teamName(teamId: string): string {
    return this.db.get<TeamRow>('SELECT name FROM teams WHERE id = ?', [teamId])?.name ?? '';
  }

  createProduction(
    teamId: string,
    ownerUserId: string | undefined,
    dto: BriefFieldsDto & { title: string; canvas?: { width: number; height: number } },
  ): ProductionDto {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO productions
         (id, team_id, title, brief, canvas, created_at, updated_at, owner_user_id,
          goal, audience, tone, notes, youtube_channels, keywords,
          episode_target_seconds, max_episodes, aspect, language, music)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, teamId, dto.title,
        dto.description ?? null,
        dto.canvas ? JSON.stringify(dto.canvas) : null,
        now, now,
        ownerUserId ?? null,
        dto.goal ?? null,
        dto.audience ?? null,
        dto.tone ?? null,
        dto.notes ?? null,
        dto.youtubeChannels?.length ? JSON.stringify(dto.youtubeChannels) : null,
        dto.keywords?.length ? JSON.stringify(dto.keywords) : null,
        dto.episodeTargetSeconds ?? null,
        dto.maxEpisodes ?? null,
        dto.aspect ?? null,
        dto.language ?? null,
        musicToDb(dto.music),
      ],
    );

    // Atomic: also insert sources if provided
    if (dto.sources?.length) {
      for (const folderId of dto.sources) {
        this.db.run(
          'INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)',
          [id, folderId, now],
        );
      }
    }

    return this.getProduction(id)!;
  }

  /** Global paged list of productions visible to `userId`. Admins pass `isAdmin = true` to see all. */
  listProductionsPaged(
    userId: string,
    isAdmin: boolean,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string; teamId?: string; status?: string },
  ): Paged<ProductionDto> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const colMap: Record<string, string> = {
      title: 'p.title', updatedAt: 'p.updated_at', createdAt: 'p.created_at', status: 'p.status',
    };
    const orderCol = colMap[opts.sortBy ?? 'updatedAt'] ?? 'p.updated_at';
    const orderDir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const params: (string | number)[] = [];
    const conditions: string[] = ["p.status != 'archived'"];

    if (!isAdmin) {
      conditions.push('EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = p.team_id AND tm.user_id = ?)');
      params.push(userId);
    }
    if (opts.teamId) {
      conditions.push('p.team_id = ?');
      params.push(opts.teamId);
    }
    if (opts.q) {
      conditions.push('(p.title LIKE ? OR p.brief LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT p.* FROM productions p ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) as n FROM productions p ${where}`;

    const rows = this.db.all<ProductionRow>(sql, [...params, pageSize, offset]);
    const total = (this.db.get<{ n: number }>(countSql, params)?.n ?? 0);

    const items = rows.map((row) => {
      const sources = this.db.all<ProductionSourceRow>(
        'SELECT source_id FROM production_sources WHERE production_id = ? ORDER BY added_at, source_id',
        [row.id],
      ).map((s) => s.source_id);
      const { run, episodes } = this.loadRunAndEpisodes(row.id, row.run_id);
      const tName = this.teamName(row.team_id);
      return this.rowToDto(row, sources, run, episodes, tName);
    });

    // Apply derived status filter after materialisation
    const filtered = opts.status
      ? items.filter((p) => p.status === opts.status)
      : items;

    return { items: filtered, total, page, pageSize };
  }

  /** Paged list of productions for a specific team (alias for listProductionsPaged with teamId). */
  listTeamProductionsPaged(
    teamId: string,
    userId: string,
    isAdmin: boolean,
    opts: { page?: number; pageSize?: number; sortBy?: string; sortOrder?: string; q?: string; status?: string },
  ): Paged<ProductionDto> {
    return this.listProductionsPaged(userId, isAdmin, { ...opts, teamId });
  }

  getProduction(id: string): ProductionDto | null {
    const row = this.db.get<ProductionRow>('SELECT * FROM productions WHERE id = ?', [id]);
    if (!row) return null;
    const sources = this.db.all<ProductionSourceRow>(
      'SELECT source_id FROM production_sources WHERE production_id = ? ORDER BY added_at, source_id',
      [id],
    ).map((s) => s.source_id);
    const { run, episodes } = this.loadRunAndEpisodes(id, row.run_id);
    const tName = this.teamName(row.team_id);
    return this.rowToDto(row, sources, run, episodes, tName);
  }

  updateProduction(
    id: string,
    updates: BriefFieldsDto & { title?: string; canvas?: { width: number; height: number } },
  ): ProductionDto {
    const existing = this.db.get<ProductionRow>('SELECT * FROM productions WHERE id = ?', [id]);
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    const pick = <T>(v: T | undefined, current: T): T => (v !== undefined ? v : current);

    this.db.run(
      `UPDATE productions SET
         title = ?, brief = ?, canvas = ?,
         goal = ?, audience = ?, tone = ?, notes = ?,
         youtube_channels = ?, keywords = ?,
         episode_target_seconds = ?, max_episodes = ?,
         aspect = ?, language = ?, music = ?, updated_at = ?
       WHERE id = ?`,
      [
        pick(updates.title, existing.title),
        pick(updates.description, existing.brief),
        updates.canvas !== undefined ? (updates.canvas ? JSON.stringify(updates.canvas) : null) : existing.canvas,
        pick(updates.goal, existing.goal),
        pick(updates.audience, existing.audience),
        pick(updates.tone, existing.tone),
        pick(updates.notes, existing.notes),
        updates.youtubeChannels !== undefined
          ? (updates.youtubeChannels?.length ? JSON.stringify(updates.youtubeChannels) : null)
          : existing.youtube_channels,
        updates.keywords !== undefined
          ? (updates.keywords?.length ? JSON.stringify(updates.keywords) : null)
          : existing.keywords,
        pick(updates.episodeTargetSeconds, existing.episode_target_seconds),
        pick(updates.maxEpisodes, existing.max_episodes),
        pick(updates.aspect, existing.aspect),
        pick(updates.language, existing.language),
        updates.music !== undefined ? musicToDb(updates.music) : existing.music,
        now,
        id,
      ],
    );

    // Update sources atomically if provided
    if (updates.sources !== undefined) {
      this.db.run('DELETE FROM production_sources WHERE production_id = ?', [id]);
      for (const folderId of updates.sources) {
        this.db.run(
          'INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)',
          [id, folderId, now],
        );
      }
    }

    return this.getProduction(id)!;
  }

  setSources(id: string, folderIds: string[]): void {
    const existing = this.db.get<ProductionRow>('SELECT id FROM productions WHERE id = ?', [id]);
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    this.db.run('DELETE FROM production_sources WHERE production_id = ?', [id]);
    for (const folderId of folderIds) {
      this.db.run(
        'INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)',
        [id, folderId, now],
      );
    }
  }

  archiveProduction(id: string): void {
    const result = this.db.run(
      "UPDATE productions SET status = 'archived', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), id],
    );
    if (result.changes === 0) throw new NotFoundException(`Production ${id} not found`);
  }

  getProductionTeamId(id: string): string | null {
    const row = this.db.get<{ team_id: string }>('SELECT team_id FROM productions WHERE id = ?', [id]);
    return row?.team_id ?? null;
  }

  /** Return all episode IDs for a production (used by DELETE to cancel before archiving). */
  getEpisodeIds(productionId: string): string[] {
    return this.db.all<{ id: string }>(
      'SELECT id FROM episodes WHERE production_id = ?',
      [productionId],
    ).map((r) => r.id);
  }
}
