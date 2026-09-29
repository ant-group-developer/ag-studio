import { Module } from '@nestjs/common';
import { FarmController } from './farm.controller';

@Module({
  controllers: [FarmController],
})
export class FarmModule {}
