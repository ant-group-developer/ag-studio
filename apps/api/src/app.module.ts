import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnv } from './config/env';
import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { Auth0Guard } from './auth/auth0.guard';
import { TeamsModule } from './teams/teams.module';
import { ProductionsModule } from './productions/productions.module';
import { FarmModule } from './farm/farm.module';
import { HealthModule } from './health/health.module';
import { StudioModule } from './studio/studio.module';
import { RequestIdMiddleware } from './common/request-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DbModule,
    AuthModule,
    TeamsModule,
    ProductionsModule,
    FarmModule,
    HealthModule,
    StudioModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: Auth0Guard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
