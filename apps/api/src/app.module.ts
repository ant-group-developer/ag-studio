import { Module } from '@nestjs/common';
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
  ],
  providers: [
    { provide: APP_GUARD, useClass: Auth0Guard },
  ],
})
export class AppModule {}
