// OpenTelemetry instrumentation MUST be imported before any other module so
// that the auto-instrumentations patch HTTP / Mongo / Redis clients before
// the app starts handling requests. Empty endpoint = safe no-op.
import './observability/tracing';
// Sentry instrumentation MUST be imported before any other module so that
// HTTP / DB clients are patched before the app starts handling requests.
import './instrument';

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RequestMethod, ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { resolveCorsOrigin } from './common/security/cors-origin';
import { env } from './config/env';

// Triple-lock: refuse to start when AUTH_OTP_MOCK=true in production unless the
// operator has ALSO set ALLOW_AUTH_OTP_MOCK_IN_PROD=true. The combo is reserved
// for emergency war-room toggles when MSG91 is fully broken AND we still need
// users to log in. Documented in REQUIREMENTS.md.
if (env.nodeEnv === 'production' && env.authOtp.mockEnabled && !env.authOtp.mockAllowInProd) {
  throw new Error(
    'FATAL: AUTH_OTP_MOCK=true in production without ALLOW_AUTH_OTP_MOCK_IN_PROD=true. Refusing to start — fixed OTP "123456" would be accepted for every account. Unset AUTH_OTP_MOCK or explicitly set ALLOW_AUTH_OTP_MOCK_IN_PROD=true.',
  );
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Env-driven log levels (Connect startup audit — Finding 1). Applied at
    // create time so it also suppresses the InstanceLoader/route-map bootstrap
    // lines (all emitted at `log`). In production this resolves to
    // warn+error+fatal: ~1,300+ boot-chatter lines are dropped and per-request
    // SUCCESS logs (emitted at `log` by Finding 2) fall out of the prod stream,
    // while warnings + errors — including the structured failed-request lines —
    // are kept. Dev keeps all levels. Spread to hand Nest a mutable LogLevel[].
    logger: [...env.logging.levels],
  });

  // Loud reminder when mock is intentionally on in prod (war-room only). Log
  // every minute so it can never fade into the background.
  if (env.nodeEnv === 'production' && env.authOtp.mockEnabled && env.authOtp.mockAllowInProd) {
    const warn = () =>
      Logger.warn(
        'AUTH_OTP_MOCK enabled in PRODUCTION — fixed OTP "123456" is accepted. Disable immediately once MSG91 recovers.',
        'AuthOtpMock',
      );
    warn();
    setInterval(warn, 60_000);
  }

  // Correlation-id middleware (Connect startup audit — Finding 2). Registered
  // FIRST so it wraps the entire request chain (including routes excluded from
  // the /api prefix): it stamps req.requestId + start time, echoes the
  // X-Request-Id response header, and opens the AsyncLocalStorage context that
  // makes the id reachable from any downstream logger. The structured request
  // logger (interceptor) + exception filter read these to correlate and time
  // every success/failure line.
  app.use(requestContextMiddleware);

  // Security headers — CSP, X-Frame-Options, HSTS, X-Content-Type-Options,
  // Referrer-Policy, etc. Defaults are sane; override only if a frontend
  // resource gets blocked. crossOriginResourcePolicy relaxed so cross-origin
  // image/asset loads from the API still work.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // CORS (launch hardening — Workstream F). Production is LOCKED to an allowlist
  // (CORS_ALLOWED_ORIGINS, falling back to the configured web URLs); non-production
  // reflects any origin for dev convenience. See common/security/cors-origin.ts.
  // enableCors reflects a matching allowlisted origin, which credentials:true
  // requires (a bare '*' is invalid with credentials).
  const corsOrigin = resolveCorsOrigin({
    nodeEnv: env.nodeEnv,
    allowedOrigins: env.corsAllowedOrigins,
    knownWebUrls: [env.webAppUrl, env.publicWebUrl, env.nextPublicAppUrl],
  });
  if (env.nodeEnv === 'production' && corsOrigin === false) {
    Logger.warn(
      'CORS: production with no CORS_ALLOWED_ORIGINS and no web URL configured — ' +
        'cross-origin browser requests are BLOCKED. Set CORS_ALLOWED_ORIGINS (or WEB_APP_URL) ' +
        'to your real web origin.',
      'CORS',
    );
  } else {
    Logger.log(
      `CORS origin policy: ${corsOrigin === true ? 'reflect-any (non-production)' : JSON.stringify(corsOrigin)}`,
      'CORS',
    );
  }
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Global Pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global Interceptors and Filters
  app.useGlobalInterceptors(new ResponseInterceptor(), new LoggingInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global Guards - PlatformAccessGuard is now registered in app.module.ts via APP_GUARD

  // Global API prefix. Every controller declares its bare resource path; this
  // adds `/api` in front of all of them. The `exclude` list keeps URLs that
  // are committed to externally (devices, payment-gateway webhooks, customer
  // portal links) at the same paths they have today.
  app.setGlobalPrefix('api', {
    exclude: [
      // Health check / root probe (k8s liveness, load-balancer health).
      { path: '', method: RequestMethod.ALL },
      // ADMS device ingest — physically configured on time clocks.
      { path: 'iclock', method: RequestMethod.ALL },
      { path: 'iclock/(.*)', method: RequestMethod.ALL },
      // Customer-facing party portal — links embedded in shared PDFs.
      { path: 'portal', method: RequestMethod.ALL },
      { path: 'portal/(.*)', method: RequestMethod.ALL },
      // Payment-gateway webhooks — URLs registered with external providers.
      {
        path: 'workspaces/:wsId/finance/webhooks/razorpay',
        method: RequestMethod.ALL,
      },
      {
        path: 'workspaces/:wsId/finance/webhooks/razorpay/(.*)',
        method: RequestMethod.ALL,
      },
      {
        path: 'workspaces/:wsId/finance/webhooks/cashfree',
        method: RequestMethod.ALL,
      },
      {
        path: 'workspaces/:wsId/finance/webhooks/cashfree/(.*)',
        method: RequestMethod.ALL,
      },
      // Phase D1d — platform-level Razorpay SaaS subscription webhook.
      // URL committed externally in the Razorpay dashboard.
      { path: 'razorpay/webhook', method: RequestMethod.POST },
    ],
  });

  // Swagger docs
  const config = new DocumentBuilder().setTitle('ManekHR API').setVersion('1.0').build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Web/worker process split (scheduler-contract ADR, Layer 0). When this
  // process serves HTTP only (`PROCESS_ROLE=web`), stop every registered cron at
  // boot so scheduled jobs run on the worker role exclusively. Single-fire across
  // multiple workers is additionally guaranteed by the Redis single-flight lock.
  if (env.processRole === 'web') {
    try {
      const scheduler = app.get(SchedulerRegistry, { strict: false });
      const crons = scheduler.getCronJobs();
      crons.forEach((job) => void job.stop());
      Logger.log(
        `PROCESS_ROLE=web — stopped ${crons.size} scheduled cron job(s); this process serves HTTP only.`,
        'Scheduler',
      );
    } catch (err) {
      Logger.warn(
        `PROCESS_ROLE=web — could not access SchedulerRegistry to stop crons: ${
          err instanceof Error ? err.message : String(err)
        }`,
        'Scheduler',
      );
    }
  }

  // Socket.IO — back the Connect feed gateway with the Redis adapter so events
  // fan out across instances. Best-effort: if Redis is unreachable the gateway
  // falls back to the in-memory adapter (a single instance is fully functional).
  const ioAdapter = new RedisIoAdapter(app);
  try {
    const config = app.get(ConfigService);
    await ioAdapter.connectToRedis(
      config.get<string>('REDIS_HOST', 'localhost'),
      config.get<number>('REDIS_PORT', 6379),
      config.get<string>('REDIS_PASSWORD') || undefined,
    );
  } catch (err) {
    Logger.warn(
      `Socket.IO Redis adapter unavailable — using the in-memory adapter. ${
        err instanceof Error ? err.message : String(err)
      }`,
      'RedisIoAdapter',
    );
  }
  app.useWebSocketAdapter(ioAdapter);

  // text/plain body parser for ADMS ingest routes (ZKTeco PUSH protocol).
  // Must be registered before app.listen() so ATTLOG POST bodies are parsed as strings.
  // express.text() is required because bodyParser:true only installs JSON parsing.
  app.use('/iclock', express.text({ type: '*/*', limit: '64kb' }));

  const port = env.port;
  console.log(`[ManekHR] NestJS Server compiling and listening on port ${port}...`);
  await app.listen(port);
}
bootstrap();
