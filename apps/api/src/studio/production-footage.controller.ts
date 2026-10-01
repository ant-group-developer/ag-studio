import { Controller, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { readStageDocument } from '@ag-studio/engine';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StudioDbService } from '../db/studio-db.service';
import { EngineService } from './engine.service';
import { FootageAccessService } from './footage-access.service';
import { mapErrors } from './http-errors';

/** `studio.catalog/v2` as far as this controller reads it (the web gets the document whole). */
interface StudioCatalog { assets: { asset_id: string }[] }

/**
 * The videos a production works with (`docs/studio-api-v3.md`, Productions): the plan run's catalog, and the
 * preview of one of its videos for the editor and the plan editor.
 */
@Controller('productions/:id')
@UseGuards(RolesGuard)
export class ProductionFootageController {
  constructor(
    private readonly engine: EngineService,
    private readonly db: StudioDbService,
    private readonly footage: FootageAccessService,
  ) {}

  /** `StudioCatalog` of the plan run; 404 before the catalog stage ran. */
  @Get('catalog')
  @Roles('viewer')
  catalog(@Param('id') id: string) {
    return mapErrors(() => this.readCatalog(id));
  }

  /**
   * Preview, poster and keyframes of one video of the catalog, signed by ag-go for the caller: sharing a
   * production never widens anyone's footage scope, so ag-go answers 403 for a folder the caller cannot see.
   */
  @Get('assets/:assetId/media')
  @Roles('viewer')
  assetMedia(@Param('id') id: string, @Param('assetId') assetId: string, @Req() req: Request) {
    return mapErrors(async () => {
      if (!this.readCatalog(id).assets.some((a) => a.asset_id === assetId)) {
        throw new NotFoundException({ code: 'asset_not_in_production', message: `asset ${assetId} is not in this production` });
      }
      return this.footage.assetMedia(req.authContext!.userId, assetId);
    });
  }

  private readCatalog(productionId: string): StudioCatalog {
    const row = this.db.get<{ run_id: string | null }>('SELECT run_id FROM productions WHERE id = ?', [productionId]);
    if (!row?.run_id) throw new NotFoundException({ code: 'no_run', message: 'no plan run yet for this production' });
    return readStageDocument(this.engine.core, row.run_id, 'catalog', 'catalog.json') as StudioCatalog;
  }
}
