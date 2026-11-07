import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ApiResponseInterceptor } from './common/api-response.interceptor';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { CORS_OPTIONS } from './common/cors';
import { SiteNameService } from './ag-go/site-name.service';
import { StudioDbService } from './db/studio-db.service';
import { errorEventRecorder } from '@ag-studio/engine';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(CORS_OPTIONS);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
  const siteName = app.get(SiteNameService);
  // a 5xx is also kept for the admin's diagnostics (error_events, migration 0012)
  const errors = errorEventRecorder({ db: app.get(StudioDbService).db, service: 'studio-api' });
  app.useGlobalFilters(new ApiExceptionFilter(() => siteName.current(), errors));
  const port = process.env['PORT'] ?? 3100;
  await app.listen(port);
  console.log(`AG Studio API listening on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
