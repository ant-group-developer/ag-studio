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
  target_seconds: number | null;
  aspect: string | null;
  language: string | null;
  voice: string | null;
  music: string | null;
}

interface ProductionSourceRow {
  source_id: string;
  added_at: string;
}

export interface ProductionDto {
  id: string;
  teamId: string;
  title: string;
  status: string;
  canvas: { width: number; height: number } | null;
  brief: string | null;
  runId: string | null;
  createdAt: string;
  updatedAt: string;
  sources?: string[];
  ownerUserId: string | null;
  targetSeconds: number | null;
  aspect: '16:9' | '9:16';
  language: string;
  voice: { reference: string | null; referenceText: string | null; speed: number };
  music: { track: string; gainDb: number; ducking: boolean } | null;
}

/** API (camelCase) <-> stored brief JSON (the snake_case shape `intake` hands to the brief schema). */
function voiceToDb(v: BriefFieldsDto['voice']): string | null {
  return v ? JSON.stringify({ reference: v.reference ?? null, reference_text: v.referenceText ?? null, speed: v.speed }) : null;
}
function musicToDb(m: BriefFieldsDto['music']): string | null {
  return m ? JSON.stringify({ track: m.track, gain_db: m.gainDb, ducking: m.ducking }) : null;
}

@Injectable()
export class ProductionsService {
  constructor(private readonly db: StudioDbService) {}

  private rowToDto(row: ProductionRow, sources?: string[]): ProductionDto {
    return {
      id: row.id,
      teamId: row.team_id,
      title: row.title,
      status: row.status,
      canvas: row.canvas ? (JSON.parse(row.canvas) as { width: number; height: number }) : null,
      brief: row.brief,
      runId: row.run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sources,
      ownerUserId: row.owner_user_id,
      targetSeconds: row.target_seconds,
      aspect: (row.aspect ?? '16:9') as '16:9' | '9:16',
      language: row.language ?? 'vi',
      voice: (() => {
        const v = row.voice ? (JSON.parse(row.voice) as { reference: string | null; reference_text: string | null; speed: number }) : null;
        return v ? { reference: v.reference, referenceText: v.reference_text, speed: v.speed } : { reference: null, referenceText: null, speed: 1 };
      })(),
      music: (() => {
        const m = row.music ? (JSON.parse(row.music) as { track: string; gain_db: number; ducking: boolean }) : null;
        return m ? { track: m.track, gainDb: m.gain_db, ducking: m.ducking } : null;
      })(),
    };
  }

  createProduction(
    teamId: string,
    title: string,
    brief?: string,
    canvas?: { width: number; height: number },
    ownerUserId?: string,
    fields: BriefFieldsDto = {},
  ): ProductionDto {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO productions (id, team_id, title, brief, canvas, created_at, updated_at,
         owner_user_id, target_seconds, aspect, language, voice, music)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, teamId, title, brief ?? null, canvas ? JSON.stringify(canvas) : null, now, now,
        ownerUserId ?? null, fields.targetSeconds ?? null, fields.aspect ?? null, fields.language ?? null,
        voiceToDb(fields.voice), musicToDb(fields.music),
      ],
    );
    return this.getProduction(id)!;
  }

  listProductions(teamId: string): ProductionDto[] {
    const rows = this.db.all<ProductionRow>(
      'SELECT * FROM productions WHERE team_id = ? AND status != ? ORDER BY created_at DESC',
      [teamId, 'archived'],
    );
    return rows.map((r) => this.rowToDto(r));
  }

  getProduction(id: string): ProductionDto | null {
    const row = this.db.get<ProductionRow>('SELECT * FROM productions WHERE id = ?', [id]);
    if (!row) return null;
    const sources = this.db.all<ProductionSourceRow>(
      'SELECT source_id FROM production_sources WHERE production_id = ?',
      [id],
    );
    return this.rowToDto(row, sources.map((s) => s.source_id));
  }

  updateProduction(
    id: string,
    updates: { title?: string; brief?: string; canvas?: { width: number; height: number } } & BriefFieldsDto,
  ): ProductionDto {
    const existing = this.db.get<ProductionRow>('SELECT * FROM productions WHERE id = ?', [id]);
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    const pick = <T>(v: T | undefined, current: T): T => (v !== undefined ? v : current);
    this.db.run(
      `UPDATE productions SET title = ?, brief = ?, canvas = ?, target_seconds = ?, aspect = ?, language = ?,
         voice = ?, music = ?, updated_at = ? WHERE id = ?`,
      [
        pick(updates.title, existing.title),
        pick(updates.brief, existing.brief),
        updates.canvas !== undefined ? (updates.canvas ? JSON.stringify(updates.canvas) : null) : existing.canvas,
        pick(updates.targetSeconds, existing.target_seconds),
        pick(updates.aspect, existing.aspect),
        pick(updates.language, existing.language),
        updates.voice !== undefined ? voiceToDb(updates.voice) : existing.voice,
        updates.music !== undefined ? musicToDb(updates.music) : existing.music,
        now,
        id,
      ],
    );
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
}
