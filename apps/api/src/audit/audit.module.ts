import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StudioModule } from '../studio/studio.module';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';

/** The activity log: every write request is recorded by `AuditInterceptor`. */
@Module({
  imports: [StudioModule],
  controllers: [AuditController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
