import { Global, Module } from '@nestjs/common';
import { StudioDbService } from './studio-db.service';

@Global()
@Module({
  providers: [StudioDbService],
  exports: [StudioDbService],
})
export class DbModule {}
