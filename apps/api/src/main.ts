import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  const port = process.env['PORT'] ?? 3100;
  await app.listen(port);
  console.log(`AG Studio API listening on port ${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
