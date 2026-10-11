import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { StudioModule } from '../studio/studio.module';
import { AuditInterceptor } from './audit.interceptor';

/** The activity log: every write request is recorded by `AuditInterceptor`. */
@Module({
  imports: [StudioModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
