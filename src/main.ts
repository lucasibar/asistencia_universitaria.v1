import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { json } from 'express';
import { AppModule } from './app';
import { CONFIG, Config } from './config';
import { ApiErrors } from './errors';
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const config = app.get<Config>(CONFIG);
  app.set('trust proxy', config.proxyHops);
  app.use(helmet());
  app.use(json({ limit: '16kb' }));
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.enableCors({ origin: config.origins, methods: ['GET', 'POST'], allowedHeaders: ['Authorization', 'Content-Type'] });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new ApiErrors());
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}
bootstrap().catch(() => { console.error('Backend startup failed. Check configuration and connectivity.'); process.exitCode = 1; });
