import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';
import { StudioDbService } from '../db/studio-db.service';
import { ConfigService } from '@nestjs/config';
import { EngineService } from '../studio/engine.service';

describe('Productions setSources validation', () => {
  let controller: ProductionsController;
  let productionsService: Partial<ProductionsService>;
  let agGoClientGetFolders: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agGoClientGetFolders = vi.fn();

    productionsService = {
      getProduction: vi.fn().mockReturnValue({
        id: 'prod-1',
        teamId: 'team-1',
        title: 'Test Production',
        status: 'draft',
        canvas: null,
        brief: null,
        runId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sources: [],
      }),
      setSources: vi.fn(),
    };

    const mockConfig = {
      get: vi.fn((key: string) => {
        const map: Record<string, string> = {
          AG_GO_API_URL: 'http://localhost:4000',
          AG_GO_SERVICE_KEY: 'test-key',
        };
        return map[key] ?? null;
      }),
    } as unknown as ConfigService;

    const mockEngine = {
      core: {},
      db: {},
    } as unknown as EngineService;

    // Direct instantiation — avoids NestJS DI / emitDecoratorMetadata issues in vitest
    controller = new ProductionsController(
      productionsService as ProductionsService,
      mockConfig,
      mockEngine,
    );

    // Replace internal AgGoClient with mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).agGoClient = {
      getFolders: agGoClientGetFolders,
    };
  });

  it('accepts valid folderIds that are accessible via ag-go', async () => {
    agGoClientGetFolders.mockResolvedValue({
      folders: [
        { id: 'folder-1', name: 'F1', parentId: null, path: '/F1', analyzedVideos: 0, usableVideos: 0 },
        { id: 'folder-2', name: 'F2', parentId: null, path: '/F2', analyzedVideos: 0, usableVideos: 0 },
      ],
    });

    const req = { authContext: { userId: 'user-1', accessToken: 'token' } } as never;
    const result = await controller.setSources('prod-1', { folderIds: ['folder-1'] }, req);
    expect(result).toEqual({ ok: true, sourceCount: 1 });
    expect(productionsService.setSources).toHaveBeenCalledWith('prod-1', ['folder-1']);
  });

  it('rejects folderIds not returned by ag-go getFolders (not accessible)', async () => {
    agGoClientGetFolders.mockResolvedValue({
      folders: [
        { id: 'folder-1', name: 'F1', parentId: null, path: '/F1', analyzedVideos: 0, usableVideos: 0 },
      ],
    });

    const req = { authContext: { userId: 'user-1', accessToken: 'token' } } as never;
    await expect(
      controller.setSources('prod-1', { folderIds: ['folder-1', 'invalid-folder'] }, req),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(productionsService.setSources).not.toHaveBeenCalled();
  });

  it('rejects when none of the folderIds are accessible', async () => {
    agGoClientGetFolders.mockResolvedValue({ folders: [] });

    const req = { authContext: { userId: 'user-1', accessToken: 'token' } } as never;
    await expect(
      controller.setSources('prod-1', { folderIds: ['folder-x'] }, req),
    ).rejects.toThrow(UnprocessableEntityException);
  });
});
