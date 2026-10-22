import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe, INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';
import { ENV } from './database/database.module';
import { Env } from './config/env';

/** Security baseline shared by the server and the integration tests (SDD Section 26.5). */
export function configureApp(app: INestApplication) {
  const env = app.get<Env>(ENV);
  app.setGlobalPrefix('api');
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(rateLimit({ windowMs: env.rateLimit.windowSeconds * 1000, limit: env.rateLimit.max, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.enableCors({ origin: env.corsOrigins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  return env;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const env = configureApp(app);
  app.enableShutdownHooks();
  await app.listen(env.port, '0.0.0.0');
  new Logger('Creditum').log(`API listening on port ${env.port} (database: ${env.dbType}, auth: ${env.authMode})`);
}

if (require.main === module) {
  bootstrap().catch(err => { console.error(err); process.exit(1); });
}
