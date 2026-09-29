import { Injectable, NotFoundException } from '@nestjs/common';
import { StudioDbService } from '../db/studio-db.service';

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
    };
  }

  createProduction(
    teamId: string,
    title: string,
    brief?: string,
    canvas?: { width: number; height: number },
  ): ProductionDto {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO productions (id, team_id, title, brief, canvas, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, teamId, title, brief ?? null, canvas ? JSON.stringify(canvas) : null, now, now],
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
    updates: { title?: string; brief?: string; canvas?: { width: number; height: number }; aspect?: string },
  ): ProductionDto {
    const existing = this.db.get<ProductionRow>('SELECT * FROM productions WHERE id = ?', [id]);
    if (!existing) throw new NotFoundException(`Production ${id} not found`);

    const now = new Date().toISOString();
    const title = updates.title ?? existing.title;
    const brief = updates.brief !== undefined ? updates.brief : existing.brief;
    const canvas =
      updates.canvas !== undefined
        ? updates.canvas
          ? JSON.stringify(updates.canvas)
          : null
        : existing.canvas;

    this.db.run(
      'UPDATE productions SET title = ?, brief = ?, canvas = ?, updated_at = ? WHERE id = ?',
      [title, brief, canvas, now, id],
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
