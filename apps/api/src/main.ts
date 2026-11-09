import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  // Staging/production: one JSON object per line (timestamp, level, context, message) for the log collector.
  const json = ['production', 'staging'].includes(process.env.NODE_ENV ?? '');
  const app = configureApp(await NestFactory.create(AppModule, { bufferLogs: false, logger: json ? new ConsoleLogger({ json: true, colors: false }) : undefined }));
  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log(`LiveSell API listening on :${port} (docs: /api/docs)`, 'Bootstrap');
}
void bootstrap();
