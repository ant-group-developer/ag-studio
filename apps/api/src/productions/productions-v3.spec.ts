/**
 * Unit tests for Productions v3 API: new fields, paged list, derived status, episodeCounts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ProductionsService } from './productions.service';
import { StudioDbService } from '../db/studio-db.service';

function makeDb(overrides: Partial<StudioDbService> = {}): StudioDbService {
  return {
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    run: vi.fn().mockReturnValue({ changes: 1 }),
    ...overrides,
  } as unknown as StudioDbService;
}

const baseProductionRow = {
  id: 'prod-1',
  team_id: 'team-1',
  title: 'Test Production',
  status: 'active',
  canvas: null,
  brief: 'A description',
  run_id: null,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-02T00:00:00.000Z',
  owner_user_id: 'user-1',
  aspect: '16:9',
  language: 'vi',
  music: null,
  goal: 'Grow channel',
  audience: 'Tech enthusiasts',
  tone: 'Professional',
  notes: 'Avoid politics',
  youtube_channels: '["https://youtube.com/@test"]',
  keywords: '["AI","tech"]',
  episode_target_seconds: 300,
  max_episodes: 5,
};

describe('ProductionsService — v3 fields', () => {
  let service: ProductionsService;
  let db: StudioDbService;

  beforeEach(() => {
    db = makeDb();
    service = new ProductionsService(db);
  });

  it('rowToDto maps new fields correctly via getProduction', () => {
    (db.get as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(baseProductionRow) // productions SELECT *
      .mockReturnValueOnce({ name: 'My Team' }); // teams SELECT name
    (db.all as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([{ source_id: 'folder-1' }]) // production_sources
      .mockReturnValueOnce([]); // episodes

    const prod = service.getProduction('prod-1');
    expect(prod).not.toBeNull();
    expect(prod!.description).toBe('A description');
    expect(prod!.goal).toBe('Grow channel');
    expect(prod!.audience).toBe('Tech enthusiasts');
    expect(prod!.tone).toBe('Professional');
    expect(prod!.notes).toBe('Avoid politics');
    expect(prod!.sources).toEqual(['folder-1']);
    expect(prod!.youtubeChannels).toEqual(['https://youtube.com/@test']);
    expect(prod!.keywords).toEqual(['AI', 'tech']);
    expect(prod!.episodeTargetSeconds).toBe(300);
    expect(prod!.maxEpisodes).toBe(5);
    expect(prod!.teamName).toBe('My Team');
  });

  it('getProduction returns null for missing production', () => {
    (db.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    expect(service.getProduction('nonexistent')).toBeNull();
  });

  it('archiveProduction throws 404 when production does not exist', () => {
    (db.run as ReturnType<typeof vi.fn>).mockReturnValue({ changes: 0 });
    expect(() => service.archiveProduction('missing')).toThrow(NotFoundException);
  });

  describe('deriveStatus', () => {
    /**
     * Call order for getProduction:
     *   db.get  #1  → productions row (run_id matters: null skips run query)
     *   db.all  #1  → production_sources
     *   db.get  #2  → run row (only when run_id != null)
     *   db.all  #2  → episodes
     *   db.get  #3  → team name  (db.get #2 when run_id is null)
     */
    function setupProdWithRun(runRow: object | null, episodeRows: object[] = []) {
      const hasRun = runRow !== null;
      const prodRow = { ...baseProductionRow, run_id: hasRun ? 'run-1' : null };

      const getStub = db.get as ReturnType<typeof vi.fn>;
      const allStub = db.all as ReturnType<typeof vi.fn>;
      getStub.mockReset();
      allStub.mockReset();

      getStub.mockReturnValueOnce(prodRow);             // #1 productions
      allStub.mockReturnValueOnce([]);                  // #1 production_sources
      if (hasRun) {
        getStub.mockReturnValueOnce(runRow);            // #2 run (only when run_id set)
      }
      allStub.mockReturnValueOnce(episodeRows);         // #2 episodes
      getStub.mockReturnValueOnce({ name: 'Team' });   // #3 (or #2) team name
    }

    it('returns draft when no run', () => {
      setupProdWithRun(null);
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('draft');
    });

    it('returns planning when run is RUNNING', () => {
      setupProdWithRun({ state: 'RUNNING', waiting_gate: null });
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('planning');
    });

    it('returns waiting_approval when run WAITING with approve-plan gate', () => {
      setupProdWithRun({ state: 'WAITING', waiting_gate: 'approve-plan' });
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('waiting_approval');
    });

    it('returns done when run SUCCEEDED and all episodes succeeded', () => {
      setupProdWithRun(
        { state: 'SUCCEEDED', waiting_gate: null },
        [{ status: 'succeeded', run_id: 'r1' }, { status: 'succeeded', run_id: 'r2' }],
      );
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('done');
    });

    it('returns producing when some episodes are in_progress', () => {
      setupProdWithRun(
        { state: 'SUCCEEDED', waiting_gate: null },
        [{ status: 'in_progress', run_id: 'r1' }, { status: 'succeeded', run_id: 'r2' }],
      );
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('producing');
    });

    it('returns failed when run FAILED and no episodes', () => {
      setupProdWithRun({ state: 'FAILED', waiting_gate: null });
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('failed');
    });

    it('returns archived when status column is archived', () => {
      const getStub = db.get as ReturnType<typeof vi.fn>;
      const allStub = db.all as ReturnType<typeof vi.fn>;
      getStub.mockReset().mockReturnValueOnce({ ...baseProductionRow, status: 'archived', run_id: null });
      getStub.mockReturnValueOnce({ name: 'Team' });
      allStub.mockReset().mockReturnValueOnce([]).mockReturnValueOnce([]);
      const prod = service.getProduction('prod-1');
      expect(prod!.status).toBe('archived');
    });
  });

  describe('episodeCounts', () => {
    it('counts episodes by status', () => {
      (db.get as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(baseProductionRow)
        .mockReturnValueOnce({ state: 'SUCCEEDED', waiting_gate: null })
        .mockReturnValueOnce({ name: 'Team' });
      (db.all as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce([])
        .mockReturnValueOnce([
          { status: 'succeeded', run_id: 'r1' },
          { status: 'succeeded', run_id: 'r2' },
          { status: 'failed', run_id: 'r3' },
          { status: 'in_progress', run_id: 'r4' },
        ]);
      const prod = service.getProduction('prod-1');
      expect(prod!.episodeCounts).toEqual({ total: 4, ready: 2, producing: 1, failed: 1 });
    });
  });

  describe('listProductionsPaged', () => {
    it('filters by teamId for non-admin', () => {
      (db.all as ReturnType<typeof vi.fn>).mockReturnValueOnce([baseProductionRow]);
      (db.get as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce({ n: 1 })        // COUNT(*)
        .mockReturnValueOnce([])              // production_sources call via all
        // remaining calls for rowToDto
        .mockReturnValue(null);
      // Reset all mocks for cleaner test
      const mockGet = vi.fn();
      const mockAll = vi.fn();
      const mockRun = vi.fn().mockReturnValue({ changes: 1 });
      const db2 = { get: mockGet, all: mockAll, run: mockRun } as unknown as StudioDbService;
      const svc2 = new ProductionsService(db2);

      // productions list
      mockAll.mockReturnValueOnce([baseProductionRow]);
      // count query
      mockGet.mockReturnValueOnce({ n: 1 });
      // production_sources
      mockAll.mockReturnValueOnce([]);
      // episodes (via all)
      mockAll.mockReturnValueOnce([]);
      // run (via get)
      mockGet.mockReturnValueOnce(null);
      // team name
      mockGet.mockReturnValueOnce({ name: 'Team' });

      const result = svc2.listProductionsPaged('user-1', false, { teamId: 'team-1', page: 1, pageSize: 10 });
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      // The call should include team condition in WHERE
      const sqlCall = (mockAll as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(sqlCall[0]).toContain('p.team_id = ?');
    });

    it('maxEpisodes defaults to 10 when not set', () => {
      const rowWithoutMaxEpisodes = { ...baseProductionRow, max_episodes: null };
      const mockGet = vi.fn();
      const mockAll = vi.fn();
      const db2 = { get: mockGet, all: mockAll, run: vi.fn() } as unknown as StudioDbService;
      const svc2 = new ProductionsService(db2);

      mockGet.mockReturnValueOnce(rowWithoutMaxEpisodes);
      mockAll.mockReturnValueOnce([]);  // sources
      mockGet.mockReturnValueOnce(null); // run
      mockAll.mockReturnValueOnce([]);  // episodes
      mockGet.mockReturnValueOnce({ name: 'Team' }); // team name

      const prod = svc2.getProduction('prod-1');
      expect(prod!.maxEpisodes).toBe(10);
    });
  });

  describe('createProduction', () => {
    it('inserts sources atomically during creation', () => {
      const mockGet = vi.fn();
      const mockAll = vi.fn();
      const mockRun = vi.fn().mockReturnValue({ changes: 1 });
      const db2 = { get: mockGet, all: mockAll, run: mockRun } as unknown as StudioDbService;
      const svc2 = new ProductionsService(db2);

      // Mock for getProduction after create
      mockGet
        .mockReturnValueOnce({
          ...baseProductionRow,
          id: expect.any(String),
        })
        .mockReturnValueOnce(null) // run
        .mockReturnValueOnce({ name: 'Team' }); // team name
      mockAll
        .mockReturnValueOnce([{ source_id: 'folder-1' }, { source_id: 'folder-2' }]) // sources
        .mockReturnValueOnce([]); // episodes

      svc2.createProduction('team-1', 'user-1', {
        title: 'New Series',
        description: 'About tech',
        goal: 'Grow',
        sources: ['folder-1', 'folder-2'],
        maxEpisodes: 5,
      });

      // Should have inserted production + 2 sources = 3 run calls
      expect(mockRun).toHaveBeenCalledTimes(3);
      const [prodInsert, src1Insert, src2Insert] = mockRun.mock.calls;
      expect(prodInsert[0]).toContain('INSERT INTO productions');
      expect(src1Insert[0]).toContain('INSERT INTO production_sources');
      expect(src1Insert[1][1]).toBe('folder-1');
      expect(src2Insert[1][1]).toBe('folder-2');
    });
  });
});
