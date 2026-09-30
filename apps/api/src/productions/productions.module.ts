import { Module } from '@nestjs/common';
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';
import { StudioModule } from '../studio/studio.module';

@Module({
  imports: [StudioModule],
  controllers: [ProductionsController],
  providers: [ProductionsService],
  exports: [ProductionsService],
})
export class ProductionsModule {}
