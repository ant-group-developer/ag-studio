import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  episodeState,
  listEpisodes,
  type EpisodeStatus,
} from "@ag-studio/engine";
import { StudioDbService } from "../db/studio-db.service";
import { EngineService } from "../studio/engine.service";
import type { BriefFieldsDto } from "./dto/brief-fields.dto";

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
  own_channels: string | null;
  rnd: string | null;
  branding: string | null;
  /** Migration 0029: the edit style (JSON), series plan 3.2.0. */
  style?: string | null;
}

interface ProductionSourceRow {
  source_id: string;
}

/** The plan run as the status needs it. */
interface PlanRunState {
  state: string;
  /** Gate waiting for a person, if any. */
  waiting_gate: string | null;
}

interface TeamRow {
  name: string;
}

export type ProductionStatus =
  | "draft"
  | "planning"
  | "waiting_approval"
  | "producing"
  | "done"
  | "failed"
  | "archived";

export interface EpisodeCounts {
  total: number;
  ready: number;
  producing: number;
  waitingApproval: number;
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
  /** The team's own channels; `youtubeChannels` are the reference channels. */
  ownChannels: string[];
  youtubeChannels: string[];
  keywords: string[];
  /** Hints for the R&D (null = the R&D proposes); the approved R&D's values are in GET /productions/:id/rnd. */
  episodeTargetSeconds: number | null;
  maxEpisodes: number | null;
  /** Whether an approved R&D / branding exists (GET /productions/:id/rnd, /branding). */
  hasRnd: boolean;
  hasBranding: boolean;
  /** Series plan 3.2.0: whether the production has an edit style (a skipped one counts: GET /productions/:id/style). */
  hasStyle: boolean;
  aspect: "16:9" | "9:16";
  language: string;
  music: { track: string; gainDb: number; ducking: boolean } | null;
  canvas: { width: number; height: number } | null;
  status: ProductionStatus;
  /** With `waiting_approval`: which approval the plan run waits for. */
  waitingGate: "approve-trend-report" | "approve-rnd" | "approve-branding" | "approve-plan" | "approve-style" | null;
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

/**
 * The music column from a form. A track the person gave by link or upload keeps where it came from while the form sends
 * the same track back (only gain or ducking changed).
 */
function musicToDb(m: BriefFieldsDto["music"], existing: string | null = null): string | null {
  if (!m) return null;
  const before = existing ? (JSON.parse(existing) as { track?: string; source?: unknown; sha256?: string; duration_s?: number }) : null;
  const kept = before && before.track === m.track && before.source
    ? { source: before.source, sha256: before.sha256, duration_s: before.duration_s }
    : {};
  return JSON.stringify({ track: m.track, gain_db: m.gainDb, ducking: m.ducking, ...kept });
}

function parseMusic(
  raw: string | null,
): { track: string; gainDb: number; ducking: boolean } | null {
  if (!raw) return null;
  const m = JSON.parse(raw) as {
    track: string;
    gain_db: number;
    ducking: boolean;
  };
  return { track: m.track, gainDb: m.gain_db, ducking: m.ducking };
}

/** The plan run's approvals: R&D, branding, episode plan. */
/** Series plan 3.2.0 adds the edit style learned from reference videos. */
const APPROVAL_GATES = new Set(["approve-trend-report", "approve-rnd", "approve-branding", "approve-plan", "approve-style"]);

/** Own and reference channels together are what research reads: at most 20. */
function checkChannelCount(own: string[] | undefined, reference: string[] | undefined): void {
  if ((own?.length ?? 0) + (reference?.length ?? 0) > 20) {
    throw new BadRequestException({ code: "too_many_channels", message: "Tối đa 20 kênh (của mình và tham khảo cộng lại)" });
  }
}

const listOrNull = (v: string[] | undefined | null): string | null => (v?.length ? JSON.stringify(v) : null);

/**
 * Derive ProductionStatus from the plan run state, waiting gate, and episode states.
 * The DB status column is only used for 'archived'.
 */
export function deriveStatus(
  row: Pick<ProductionRow, "status">,
  run: PlanRunState | null,
  episodes: EpisodeStatus[],
): ProductionStatus {
  if (row.status === "archived") return "archived";
  if (!run) return "draft";

  const runState = run.state;
  if (run.waiting_gate && APPROVAL_GATES.has(run.waiting_gate) && !["SUCCEEDED", "FAILED", "CANCELLED"].includes(runState)) {
    return "waiting_approval";
  }
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(runState)) {
    // run is actively going (RUNNING, or a stage waiting for someone to retry it)
    return "planning";
  }

  // Run is terminal — look at episodes
  if (episodes.length === 0) {
    if (runState === "FAILED" || runState === "CANCELLED") return "failed";
    return "planning"; // ran but no episodes yet
  }

  if (episodes.some((e) => e === "waiting_approval")) return "waiting_approval";
  if (episodes.some((e) => e === "producing")) return "producing";
  if (episodes.every((e) => e === "ready")) return "done";
  if (episodes.some((e) => e === "failed")) return "failed";
  return "producing"; // planned episodes not started yet, or cancelled ones next to ready ones
}

export function countEpisodes(episodes: EpisodeStatus[]): EpisodeCounts {
  return {
    total: episodes.length,
    ready: episodes.filter((e) => e === "ready").length,
    producing: episodes.filter((e) => e === "producing").length,
    waitingApproval: episodes.filter((e) => e === "waiting_approval").length,
    failed: episodes.filter((e) => e === "failed").length,
  };
}

@Injectable()
export class ProductionsService {
  constructor(
    private readonly db: StudioDbService,
    private readonly engine: EngineService,
  ) {}

  private rowToDto(
    row: ProductionRow,
    sources: string[],
    run: PlanRunState | null,
    episodes: EpisodeStatus[],
    teamName: string,
  ): ProductionDto {
    return {
      id: row.id,
      teamId: row.team_id,
      teamName,
      title: row.title,
      description: row.brief ?? "",
      goal: row.goal ?? "",
      audience: row.audience ?? "",
      tone: row.tone ?? "",
      notes: row.notes ?? "",
      sources,
      ownChannels: row.own_channels ? (JSON.parse(row.own_channels) as string[]) : [],
      youtubeChannels: row.youtube_channels
        ? (JSON.parse(row.youtube_channels) as string[])
        : [],
      keywords: row.keywords ? (JSON.parse(row.keywords) as string[]) : [],
      episodeTargetSeconds: row.episode_target_seconds,
      maxEpisodes: row.max_episodes,
      hasRnd: !!row.rnd,
      hasBranding: !!row.branding,
      hasStyle: !!row.style,
      aspect: (row.aspect ?? "16:9") as "16:9" | "9:16",
      language: row.language ?? "vi",
      music: parseMusic(row.music),
      canvas: row.canvas
        ? (JSON.parse(row.canvas) as { width: number; height: number })
        : null,
      status: deriveStatus(row, run, episodes),
      waitingGate: run?.waiting_gate && APPROVAL_GATES.has(run.waiting_gate)
        ? (run.waiting_gate as ProductionDto["waitingGate"])
        : null,
      runId: row.run_id,
      episodeCounts: countEpisodes(episodes),
      ownerUserId: row.owner_user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * The plan run's state and every episode's status, read through the engine (the harness store owns its tables;
   * never query them by hand).
   */
  private loadRunAndEpisodes(
    id: string,
    runId: string | null,
  ): { run: PlanRunState | null; episodes: EpisodeStatus[] } {
    const core = this.engine.core;
    const r = runId ? core.store.getRun(runId) : undefined;
    const run: PlanRunState | null = r
      ? {
          state: r.state,
          waiting_gate:
            core.store
              .listStageRuns(r.run_id)
              .find(
                (s) =>
                  s.executor.type === "gate" && s.state === "WAITING_HUMAN",
              )?.stage_key ?? null,
        }
      : null;
    const episodes = listEpisodes(this.engine.db, id).map(
      (e) => episodeState(core, this.engine.db, e).status,
    );
    return { run, episodes };
  }

  private teamName(teamId: string): string {
    return (
      this.db.get<TeamRow>("SELECT name FROM teams WHERE id = ?", [teamId])
        ?.name ?? ""
    );
  }

  createProduction(
    teamId: string,
    ownerUserId: string | undefined,
    dto: BriefFieldsDto & {
      title: string;
      canvas?: { width: number; height: number };
    },
  ): ProductionDto {
    checkChannelCount(dto.ownChannels, dto.youtubeChannels);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO productions
         (id, team_id, title, brief, canvas, created_at, updated_at, owner_user_id,
          goal, audience, tone, notes, youtube_channels, keywords,
          episode_target_seconds, max_episodes, aspect, language, music, own_channels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          teamId,
          dto.title,
          dto.description ?? null,
          dto.canvas ? JSON.stringify(dto.canvas) : null,
          now,
          now,
          ownerUserId ?? null,
          dto.goal ?? null,
          dto.audience ?? null,
          dto.tone ?? null,
          dto.notes ?? null,
          dto.youtubeChannels?.length
            ? JSON.stringify(dto.youtubeChannels)
            : null,
          dto.keywords?.length ? JSON.stringify(dto.keywords) : null,
          dto.episodeTargetSeconds ?? null,
          dto.maxEpisodes ?? null,
          dto.aspect ?? null,
          dto.language ?? null,
          musicToDb(dto.music),
          listOrNull(dto.ownChannels),
        ],
      );

      for (const folderId of dto.sources ?? []) {
        this.db.run(
          "INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)",
          [id, folderId, now],
        );
      }
    });

    return this.getProduction(id)!;
  }

  /** Global paged list of productions visible to `userId`. Admins pass `isAdmin = true` to see all. */
  listProductionsPaged(
    userId: string,
    isAdmin: boolean,
    opts: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: string;
      q?: string;
      teamId?: string;
      status?: string;
    },
  ): Paged<ProductionDto> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
    const offset = (page - 1) * pageSize;

    const colMap: Record<string, string> = {
      title: "p.title",
      updatedAt: "p.updated_at",
      createdAt: "p.created_at",
      status: "p.status",
    };
    const orderCol = colMap[opts.sortBy ?? "updatedAt"] ?? "p.updated_at";
    const orderDir = opts.sortOrder === "asc" ? "ASC" : "DESC";

    const params: (string | number)[] = [];
    const conditions: string[] = ["p.status != 'archived'"];

    if (!isAdmin) {
      conditions.push(
        "EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = p.team_id AND tm.user_id = ?)",
      );
      params.push(userId);
    }
    if (opts.teamId) {
      conditions.push("p.team_id = ?");
      params.push(opts.teamId);
    }
    if (opts.q) {
      conditions.push("(p.title LIKE ? OR p.brief LIKE ?)");
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const toDto = (row: ProductionRow) => {
      const sources = this.db
        .all<ProductionSourceRow>(
          "SELECT source_id FROM production_sources WHERE production_id = ? ORDER BY added_at, source_id",
          [row.id],
        )
        .map((s) => s.source_id);
      const { run, episodes } = this.loadRunAndEpisodes(row.id, row.run_id);
      return this.rowToDto(
        row,
        sources,
        run,
        episodes,
        this.teamName(row.team_id),
      );
    };

    if (opts.status) {
      // The status is derived from runs, so SQL cannot filter on it: filter every candidate, then page.
      const all = this.db
        .all<ProductionRow>(
          `SELECT p.* FROM productions p ${where} ORDER BY ${orderCol} ${orderDir}`,
          params,
        )
        .map(toDto)
        .filter((p) => p.status === opts.status);
      return {
        items: all.slice(offset, offset + pageSize),
        total: all.length,
        page,
        pageSize,
      };
    }
    const rows = this.db.all<ProductionRow>(
      `SELECT p.* FROM productions p ${where} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const total =
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) as n FROM productions p ${where}`,
        params,
      )?.n ?? 0;
    return { items: rows.map(toDto), total, page, pageSize };
  }

  /** Paged list of productions for a specific team (alias for listProductionsPaged with teamId). */
  listTeamProductionsPaged(
    teamId: string,
    userId: string,
    isAdmin: boolean,
    opts: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: string;
      q?: string;
      status?: string;
    },
  ): Paged<ProductionDto> {
    return this.listProductionsPaged(userId, isAdmin, { ...opts, teamId });
  }

  getProduction(id: string): ProductionDto | null {
    const row = this.db.get<ProductionRow>(
      "SELECT * FROM productions WHERE id = ?",
      [id],
    );
    if (!row) return null;
    const sources = this.db
      .all<ProductionSourceRow>(
        "SELECT source_id FROM production_sources WHERE production_id = ? ORDER BY added_at, source_id",
        [id],
      )
      .map((s) => s.source_id);
    const { run, episodes } = this.loadRunAndEpisodes(id, row.run_id);
    const tName = this.teamName(row.team_id);
    return this.rowToDto(row, sources, run, episodes, tName);
  }

  updateProduction(
    id: string,
    updates: BriefFieldsDto & {
      title?: string;
      canvas?: { width: number; height: number };
    },
  ): ProductionDto {
    const existing = this.db.get<ProductionRow>(
      "SELECT * FROM productions WHERE id = ?",
      [id],
    );
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    const pick = <T>(v: T | undefined, current: T): T =>
      v !== undefined ? v : current;
    const currentList = (v: string | null): string[] => (v ? (JSON.parse(v) as string[]) : []);
    checkChannelCount(
      updates.ownChannels ?? currentList(existing.own_channels),
      updates.youtubeChannels ?? currentList(existing.youtube_channels),
    );

    this.db.run(
      `UPDATE productions SET
         title = ?, brief = ?, canvas = ?,
         goal = ?, audience = ?, tone = ?, notes = ?,
         youtube_channels = ?, keywords = ?,
         episode_target_seconds = ?, max_episodes = ?,
         aspect = ?, language = ?, music = ?, own_channels = ?, updated_at = ?
       WHERE id = ?`,
      [
        pick(updates.title, existing.title),
        pick(updates.description, existing.brief),
        updates.canvas !== undefined
          ? updates.canvas
            ? JSON.stringify(updates.canvas)
            : null
          : existing.canvas,
        pick(updates.goal, existing.goal),
        pick(updates.audience, existing.audience),
        pick(updates.tone, existing.tone),
        pick(updates.notes, existing.notes),
        updates.youtubeChannels !== undefined
          ? updates.youtubeChannels?.length
            ? JSON.stringify(updates.youtubeChannels)
            : null
          : existing.youtube_channels,
        updates.keywords !== undefined
          ? updates.keywords?.length
            ? JSON.stringify(updates.keywords)
            : null
          : existing.keywords,
        pick(updates.episodeTargetSeconds, existing.episode_target_seconds),
        pick(updates.maxEpisodes, existing.max_episodes),
        pick(updates.aspect, existing.aspect),
        pick(updates.language, existing.language),
        updates.music !== undefined ? musicToDb(updates.music, existing.music) : existing.music,
        updates.ownChannels !== undefined ? listOrNull(updates.ownChannels) : existing.own_channels,
        now,
        id,
      ],
    );

    // Update sources atomically if provided
    if (updates.sources !== undefined) {
      this.db.run("DELETE FROM production_sources WHERE production_id = ?", [
        id,
      ]);
      for (const folderId of updates.sources) {
        this.db.run(
          "INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)",
          [id, folderId, now],
        );
      }
    }

    return this.getProduction(id)!;
  }

  setSources(id: string, folderIds: string[]): void {
    const existing = this.db.get<ProductionRow>(
      "SELECT id FROM productions WHERE id = ?",
      [id],
    );
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    this.db.run("DELETE FROM production_sources WHERE production_id = ?", [id]);
    for (const folderId of folderIds) {
      this.db.run(
        "INSERT INTO production_sources (production_id, source_id, added_at) VALUES (?, ?, ?)",
        [id, folderId, now],
      );
    }
  }

  archiveProduction(id: string): void {
    const result = this.db.run(
      "UPDATE productions SET status = 'archived', updated_at = ? WHERE id = ?",
      [new Date().toISOString(), id],
    );
    if (result.changes === 0)
      throw new NotFoundException(`Production ${id} not found`);
  }

  getProductionTeamId(id: string): string | null {
    const row = this.db.get<{ team_id: string }>(
      "SELECT team_id FROM productions WHERE id = ?",
      [id],
    );
    return row?.team_id ?? null;
  }

  /** Return all episode IDs for a production (used by DELETE to cancel before archiving). */
  getEpisodeIds(productionId: string): string[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM episodes WHERE production_id = ?", [
        productionId,
      ])
      .map((r) => r.id);
  }
}
