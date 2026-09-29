import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Request } from 'express';
import { ProductionsService } from './productions.service';
import { CreateProductionDto } from './dto/create-production.dto';
import { UpdateProductionDto } from './dto/update-production.dto';
import { SetSourcesDto } from './dto/set-sources.dto';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AgGoClient } from '../ag-go/client';
import { ConfigService } from '@nestjs/config';

@Controller()
@UseGuards(RolesGuard)
export class ProductionsController {
  private readonly agGoClient: AgGoClient;

  constructor(
    private readonly productionsService: ProductionsService,
    private readonly config: ConfigService,
  ) {
    this.agGoClient = new AgGoClient({
      baseUrl: this.config.get<string>('AG_GO_API_URL') as string,
      serviceKey: this.config.get<string>('AG_GO_SERVICE_KEY') as string,
    });
  }

  @Post('teams/:teamId/productions')
  @Roles('producer', 'owner')
  @HttpCode(HttpStatus.CREATED)
  createProduction(@Param('teamId') teamId: string, @Body() dto: CreateProductionDto, @Req() req: Request) {
    // The creator is the production's owner: background stages act as them towards ag-go (plan 3.1).
    return this.productionsService.createProduction(
      teamId,
      dto.title,
      dto.brief,
      dto.canvas,
      req.authContext!.userId,
      dto,
    );
  }

  @Get('teams/:teamId/productions')
  @Roles('viewer')
  listProductions(@Param('teamId') teamId: string) {
    return this.productionsService.listProductions(teamId);
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

  @Delete('productions/:id')
  @Roles('owner')
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveProduction(@Param('id') id: string) {
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
