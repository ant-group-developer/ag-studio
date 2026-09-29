import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { FarmController } from './farm.controller';
import { StudioDbService } from '../db/studio-db.service';
import { ConfigService } from '@nestjs/config';
import { getStageInputPrefix, getStageOutputPrefix } from './sign-schemas';

const MOCK_JOB = {
  id: 'row-1',
  farm_job_id: 'farm-job-uuid',
  run_id: 'run-1',
  stage_key: 'render-preview',
  attempt_id: 'attempt-1',
  production_id: 'prod-1',
  job_type: 'studio.render_preview',
  is_final_render: 0,
  created_at: new Date().toISOString(),
};

const MOCK_FINAL_JOB = {
  ...MOCK_JOB,
  is_final_render: 1,
  job_type: 'studio.render_final',
};

function makeTicketClaims(jobId: string, owner = 'studio') {
  return {
    iss: 'ag-farm',
    sub: 'worker-node-uuid',
    jti: 'jti-uuid',
    job_id: jobId,
    owner,
    type: 'studio.render_preview',
    attempt: 1,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe('FarmController /farm/sign', () => {
  let controller: FarmController;
  let dbGet: ReturnType<typeof vi.fn>;
  let dbRun: ReturnType<typeof vi.fn>;
  let agGoResolveSegments: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dbGet = vi.fn();
    dbRun = vi.fn().mockReturnValue({ changes: 1, lastInsertRowid: 1 });
    agGoResolveSegments = vi.fn();

    const mockDb = {
      get: dbGet,
      run: dbRun,
      all: vi.fn().mockReturnValue([]),
    } as unknown as StudioDbService;

    const mockConfig = {
      get: vi.fn((key: string, defaultVal?: unknown) => {
        const map: Record<string, string | number> = {
          STUDIO_R2_BUCKET: 'test-bucket',
          STUDIO_R2_ENDPOINT: 'https://r2.example.com',
          STUDIO_R2_ACCESS_KEY_ID: 'test-key-id',
          STUDIO_R2_SECRET_ACCESS_KEY: 'test-secret',
          AG_GO_API_URL: 'http://localhost:4000',
          AG_GO_SERVICE_KEY: 'test-key',
          FARM_URL_TTL_SECONDS: 3600,
        };
        return map[key] ?? defaultVal ?? null;
      }),
    } as unknown as ConfigService;

    // Directly instantiate the controller (avoids NestJS DI / emitDecoratorMetadata issues)
    controller = new FarmController(mockDb, mockConfig);

    // Replace the internal AgGoClient with a mock so no real HTTP calls are made
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).agGoClient = {
      resolveSegments: agGoResolveSegments,
    };

    // Replace S3 client so presigning calls are skipped where they reach that branch
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).s3 = {
      send: vi.fn().mockResolvedValue({ UploadId: 'mp-upload-id-123' }),
    };
  });

  it('returns 403 for unknown farm_job_id', async () => {
    dbGet.mockReturnValue(undefined);
    const req = {
      ticketClaims: makeTicketClaims('unknown-job-id'),
      ip: '127.0.0.1',
    } as never;
    await expect(
      controller.sign({ ops: [{ op: 'get', input: 'stage:test.json' }] }, req),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns 403 for get op with disallowed input prefix', async () => {
    dbGet.mockReturnValue(MOCK_JOB);
    const req = {
      ticketClaims: makeTicketClaims(MOCK_JOB.farm_job_id),
      ip: '127.0.0.1',
    } as never;
    // 'unknown:something' passes InputNameSchema but is not stage:/library:/segment:
    await expect(
      controller.sign({ ops: [{ op: 'get', input: 'unknown:something' }] }, req),
    ).rejects.toThrow(ForbiddenException);
  });

  it('does not write audit log for forbidden batch (fail fast)', async () => {
    dbGet.mockReturnValue(MOCK_JOB);
    const req = {
      ticketClaims: makeTicketClaims(MOCK_JOB.farm_job_id),
      ip: '127.0.0.1',
    } as never;
    await expect(
      controller.sign(
        {
          ops: [
            { op: 'get', input: 'stage:ok.mp4' }, // authorized
            { op: 'get', input: 'other:bad.mp4' }, // NOT authorized
          ],
        },
        req,
      ),
    ).rejects.toThrow(ForbiddenException);
    // Audit log must NOT have been written (nothing executed)
    expect(dbRun).not.toHaveBeenCalled();
  });

  it('uses purpose=preview when is_final_render=0', async () => {
    dbGet.mockReturnValue({ ...MOCK_JOB, is_final_render: 0 });
    agGoResolveSegments.mockResolvedValue({
      items: [
        {
          segmentId: 'seg-uuid',
          assetId: 'asset-1',
          startMs: 0,
          endMs: 5000,
          url: 'https://cdn.example.com/seg.mp4',
          sourceKind: 'preview',
          watermarked: true,
          contentType: 'video/mp4',
          sizeBytes: null,
          cacheKey: null,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });
    dbRun.mockReturnValue({ changes: 1, lastInsertRowid: 1 });

    const req = {
      ticketClaims: makeTicketClaims(MOCK_JOB.farm_job_id),
      ip: '127.0.0.1',
    } as never;
    await controller.sign({ ops: [{ op: 'get', input: 'segment:seg-uuid' }] }, req);

    expect(agGoResolveSegments).toHaveBeenCalledWith('prod-1', {
      segmentIds: ['seg-uuid'],
      purpose: 'preview',
    });
  });

  it('uses purpose=final when is_final_render=1', async () => {
    dbGet.mockReturnValue({ ...MOCK_FINAL_JOB, is_final_render: 1 });
    agGoResolveSegments.mockResolvedValue({
      items: [
        {
          segmentId: 'seg-uuid',
          assetId: 'asset-1',
          startMs: 0,
          endMs: 5000,
          url: 'https://cdn.example.com/seg.mp4',
          sourceKind: 'original',
          watermarked: false,
          contentType: 'video/mp4',
          sizeBytes: 1024000,
          cacheKey: 'cache-hash',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    });
    dbRun.mockReturnValue({ changes: 1, lastInsertRowid: 1 });

    const req = {
      ticketClaims: makeTicketClaims(MOCK_FINAL_JOB.farm_job_id),
      ip: '127.0.0.1',
    } as never;
    await controller.sign({ ops: [{ op: 'get', input: 'segment:seg-uuid' }] }, req);

    expect(agGoResolveSegments).toHaveBeenCalledWith('prod-1', {
      segmentIds: ['seg-uuid'],
      purpose: 'final',
    });
  });
});

// ---------------------------------------------------------------------------
// Key-layout: assert sign-schemas matches farm-executor (Problem 3 test vector)
// ---------------------------------------------------------------------------

describe('Key layout: sign-schemas must match farm-executor stageInputPrefix', () => {
  // The farm-executor (packages/executors) uploads inputs to:
  //   productions/<prodId>/jobs/<stageKey>/<attemptId>/in/
  // and references them as stage:<basename> in the payload.
  //
  // The sign endpoint (apps/api) resolves stage:<filename> to:
  //   getStageInputPrefix(prodId, stageKey, attemptId) + filename
  //
  // These MUST be identical; this test is the shared assertion.

  // Mirror of stageInputPrefix() in packages/executors/src/farm-executor.ts
  function executorInputPrefix(
    productionId: string,
    stageKey: string,
    attemptId: string,
  ): string {
    return `productions/${productionId}/jobs/${stageKey}/${attemptId}/in/`;
  }

  const CASES: Array<[string, string, string]> = [
    ['prod-abc', 'tts', 'attempt-001'],
    ['prod-123', 'render-preview', 'atm_XYZ'],
    ['my-production', 'render-final', 'atm-88888'],
  ];

  for (const [prodId, stageKey, attemptId] of CASES) {
    it(`input prefix matches for ${prodId}/${stageKey}/${attemptId}`, () => {
      expect(getStageInputPrefix(prodId, stageKey, attemptId)).toBe(
        executorInputPrefix(prodId, stageKey, attemptId),
      );
    });
  }

  it('output prefix is productions/<prodId>/', () => {
    expect(getStageOutputPrefix('prod-abc')).toBe('productions/prod-abc/');
  });

  it('input prefix contains attempt id (prevents cross-attempt collisions)', () => {
    const p1 = getStageInputPrefix('prod-1', 'render', 'attempt-1');
    const p2 = getStageInputPrefix('prod-1', 'render', 'attempt-2');
    expect(p1).not.toBe(p2);
    expect(p1).toContain('attempt-1');
    expect(p2).toContain('attempt-2');
  });
});
