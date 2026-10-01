import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ProductionFootageController } from './production-footage.controller';

const { readStageDocument } = vi.hoisted(() => ({ readStageDocument: vi.fn() }));
vi.mock('@ag-studio/engine', async (orig) => ({ ...(await orig<object>()), readStageDocument }));

describe('ProductionFootageController (catalog + asset media of a production)', () => {
  let runId: string | null;
  const assetMedia = vi.fn();
  const req = { authContext: { userId: 'u-caller', accessToken: 't' } } as never;
  const controller = () =>
    new ProductionFootageController(
      { core: {} } as never,
      { get: () => ({ run_id: runId }) } as never,
      { assetMedia } as never,
    );

  beforeEach(() => {
    runId = 'run-1';
    readStageDocument.mockReset().mockReturnValue({ schema_version: 'studio.catalog/v2', assets: [{ asset_id: 'a-1' }] });
    assetMedia.mockReset().mockResolvedValue({ assetId: 'a-1', previewUrl: 'https://p' });
  });

  it('returns the plan run catalog document', async () => {
    await expect(controller().catalog('p-1')).resolves.toMatchObject({ assets: [{ asset_id: 'a-1' }] });
    expect(readStageDocument).toHaveBeenCalledWith({}, 'run-1', 'catalog', 'catalog.json');
  });

  it('is 404 before the production has a plan run', async () => {
    runId = null;
    await expect(controller().catalog('p-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller().assetMedia('p-1', 'a-1', req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('signs media for the caller, only for a video of the production', async () => {
    await expect(controller().assetMedia('p-1', 'a-1', req)).resolves.toMatchObject({ previewUrl: 'https://p' });
    expect(assetMedia).toHaveBeenCalledWith('u-caller', 'a-1');
    await expect(controller().assetMedia('p-1', 'a-other', req)).rejects.toBeInstanceOf(NotFoundException);
    expect(assetMedia).toHaveBeenCalledTimes(1);
  });
});
