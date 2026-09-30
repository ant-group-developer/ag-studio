import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Request } from 'express';
import { cancelEpisode, cancelPlan } from '@ag-studio/engine';
import { ProductionsService } from './productions.service';
import { CreateProductionDto } from './dto/create-production.dto';
import { UpdateProductionDto } from './dto/update-production.dto';
import { SetSourcesDto } from './dto/set-sources.dto';
import { ListProductionsQueryDto } from './dto/list-productions-query.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AgGoClient } from '../ag-go/client';
import { ConfigService } from '@nestjs/config';
import { EngineService } from '../studio/engine.service';

@Controller()
@UseGuards(RolesGuard)
export class ProductionsController {
  private readonly agGoClient: AgGoClient;

  constructor(
    private readonly productionsService: ProductionsService,
    private readonly config: ConfigService,
    private readonly engine: EngineService,
  ) {
    this.agGoClient = new AgGoClient({
      baseUrl: this.config.get<string>('AG_GO_API_URL') as string,
      serviceKey: this.config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  /** Global paged list — all productions visible to the caller (admins see all). */
  @Get('productions')
  @Roles('viewer')
  listAllProductions(@Query() query: ListProductionsQueryDto, @Req() req: Request) {
    const { userId, isAdmin } = req.authContext!;
    return this.productionsService.listProductionsPaged(userId, isAdmin ?? false, query);
  }

  @Post('teams/:teamId/productions')
  @Roles('producer', 'owner')
  @HttpCode(HttpStatus.CREATED)
  createProduction(@Param('teamId') teamId: string, @Body() dto: CreateProductionDto, @Req() req: Request) {
    return this.productionsService.createProduction(
      teamId,
      req.authContext!.userId,
      dto,
    );
  }

  /** Team-scoped paged list (filtered alias of GET /productions?teamId=...). */
  @Get('teams/:teamId/productions')
  @Roles('viewer')
  listTeamProductions(@Param('teamId') teamId: string, @Query() query: ListProductionsQueryDto, @Req() req: Request) {
    const { userId, isAdmin } = req.authContext!;
    return this.productionsService.listTeamProductionsPaged(teamId, userId, isAdmin ?? false, query);
  }

  @Get('productions/:id')
  @Roles('viewer')
  getProduction(@Param('id') id: string) {
    const prod = this.productionsService.getProduction(id);
    if (!prod) throw new NotFoundException(`Production ${id} not found`);
    return prod;
  }

  @Patch('productions/:id')
  @Roles('producer', 'owner')
  updateProduction(@Param('id') id: string, @Body() dto: UpdateProductionDto) {
    return this.productionsService.updateProduction(id, dto);
  }

  @Post('productions/:id/sources')
  @Roles('producer', 'owner')
  async setSources(
    @Param('id') id: string,
    @Body() dto: SetSourcesDto,
    @Req() req: Request,
  ) {
    const userId = req.authContext!.userId;

    // Validate that all folderIds belong to this user's ag-go accessible folders
    const response = await this.agGoClient.getFolders(userId);
    const accessibleIds = new Set(response.folders.map((f) => f.id));
    const invalidIds = dto.folderIds.filter((fid) => !accessibleIds.has(fid));
    if (invalidIds.length > 0) {
      throw new UnprocessableEntityException(
        `Folder IDs not accessible: ${invalidIds.join(', ')}`,
      );
    }

    this.productionsService.setSources(id, dto.folderIds);
    return { ok: true, sourceCount: dto.folderIds.length };
  }

  /**
   * DELETE cancels the plan run and every episode run before archiving.
   */
  @Delete('productions/:id')
  @Roles('producer', 'owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveProduction(@Param('id') id: string) {
    const prod = this.productionsService.getProduction(id);
    if (!prod) throw new NotFoundException(`Production ${id} not found`);

    // Cancel plan run if active
    try {
      if (prod.runId) cancelPlan(this.engine.core, this.engine.db, id);
    } catch {
      // no-op: may already be terminal
    }

    // Cancel every episode run
    const episodeIds = this.productionsService.getEpisodeIds(id);
    for (const episodeId of episodeIds) {
      try {
        cancelEpisode(this.engine.core, this.engine.db, episodeId);
      } catch {
        // no-op: may already be terminal
      }
    }

    this.productionsService.archiveProduction(id);
  }

  @Get('productions/:id/access')
  @Roles('viewer')
  async checkAccess(@Param('id') id: string, @Req() req: Request) {
    const userId = req.authContext!.userId;
    const prod = this.productionsService.getProduction(id);
    if (!prod) throw new NotFoundException(`Production ${id} not found`);

    const sources = prod.sources ?? [];
    if (sources.length === 0) {
      return { hasAccess: true, missingFolderIds: [] };
    }

    const response = await this.agGoClient.getFolders(userId);
    const accessibleIds = new Set(response.folders.map((f) => f.id));
    const missingFolderIds = sources.filter((s) => !accessibleIds.has(s));

    return {
      hasAccess: missingFolderIds.length === 0,
      missingFolderIds,
    };
  }
}
