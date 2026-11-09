import { INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Env } from './config/env';
import { ErrorReportingFilter, requestId } from './common/observability';

// Money is BigInt minor units; serialize as string so JS clients never lose precision.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

/** Shared by main.ts and e2e tests so tests exercise the real HTTP pipeline. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService<Env, true>);
  const http = app.getHttpAdapter().getInstance();
  http.set('trust proxy', 1); // behind Nginx; req.ip = client IP
  http.disable('x-powered-by');

  // CSV product imports arrive as JSON text; 3 MB covers the 1,000-row limit. Other bodies are far smaller.
  (app as NestExpressApplication).useBodyParser('json', {
    limit: '3mb',
    // Webhook signatures are computed over the exact bytes received, so keep them for webhook routes only.
    verify: (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      if (req.url?.includes('/webhook')) req.rawBody = Buffer.from(buf);
    },
  });
  app.use(requestId);
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }).split(',').map((s: string) => s.trim()),
    credentials: true,
  });
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ErrorReportingFilter(app.getHttpAdapter()));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('LiveSell Africa API').setVersion('1.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }
  return app;
}
