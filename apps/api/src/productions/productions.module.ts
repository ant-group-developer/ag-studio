import { Module } from '@nestjs/common';
import { ProductionsController } from './productions.controller';
import { ProductionsService } from './productions.service';

@Module({
  controllers: [ProductionsController],
  providers: [ProductionsService],
  exports: [ProductionsService],
})
export class ProductionsModule {}
