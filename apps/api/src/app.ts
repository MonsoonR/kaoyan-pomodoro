import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import {
  ConflictAlreadyResolvedErrorSchema,
  ConflictResolutionTargetExistsErrorSchema,
  InvalidConflictResolutionErrorSchema,
} from '@kaoyan/contracts';

import { generateSessionToken } from './auth/tokens';
import {
  hashPassword,
  PRODUCTION_PASSWORD_OPTIONS,
  type PasswordOptions,
  verifyPassword,
} from './auth/password';
import type { DatabaseConnection } from './db/client';
import type { TrustProxyHops } from './config/env';
import { openDatabase } from './db/client';
import { migrateDatabase } from './db/migrate';
import { authRoutes } from './routes/auth';
import { deviceRoutes } from './routes/devices';
import { studyDataRoutes } from './routes/study-data';
import { syncRoutes } from './routes/sync';
import { timerRoutes } from './routes/timer';
import { conflictRoutes } from './routes/conflicts';
import { healthRoutes } from './routes/health';
import {
  ConflictAlreadyResolvedError,
  ConflictResolutionTargetExistsError,
  EntityNotFoundError,
  InvalidConflictResolutionError,
  StaleVersionError,
} from './services/errors';
import { StaleTimerVersionError, TimerError } from './services/timer-errors';
import { installOriginGuard } from './security/origin-guard';

const BODY_LIMIT_BYTES = 64 * 1024;

export interface AppOptions {
  database?: DatabaseConnection;
  appOrigin: string;
  now?: () => Date;
  generateToken?: () => string;
  passwordOptions?: PasswordOptions;
  verifyPassword?: typeof verifyPassword;
  loginRateLimit?: { max: number; timeWindow: string | number };
  trustProxy?: TrustProxyHops;
  logger?: boolean;
}

export async function createApp(options: AppOptions) {
  const trustProxy = options.trustProxy ?? 0;
  if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 10) {
    throw new Error('trustProxy must be an integer between 0 and 10');
  }

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: trustProxy === 0 ? false : trustProxy,
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/api' || request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
    return payload;
  });
  const ownsDatabase = !options.database;
  const connection = options.database ?? openDatabase(':memory:');
  if (ownsDatabase) migrateDatabase(connection.db);

  const passwordOptions =
    options.passwordOptions ?? PRODUCTION_PASSWORD_OPTIONS;
  const dummyPasswordHash = await hashPassword(
    'constant dummy password value',
    passwordOptions,
  );

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: options.loginRateLimit?.max ?? 10,
    timeWindow: options.loginRateLimit?.timeWindow ?? '1 minute',
    errorResponseBuilder: () => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      error: 'Too Many Requests',
      message: 'Too many login attempts',
    }),
  });

  installOriginGuard(app, options.appOrigin);
  await healthRoutes(app, connection.sqlite);
  const services = {
    sqlite: connection.sqlite,
    now: options.now ?? (() => new Date()),
    token: options.generateToken ?? generateSessionToken,
    passwordOptions,
    dummyPasswordHash,
    verifyPassword: options.verifyPassword ?? verifyPassword,
  };
  await authRoutes(
    app,
    services,
    options.loginRateLimit ?? { max: 10, timeWindow: '1 minute' },
  );
  await deviceRoutes(app, services);
  await studyDataRoutes(app, services);
  await syncRoutes(app, services);
  await timerRoutes(app, services);
  await conflictRoutes(app, services);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: 'Invalid request' });
    }
    if (error instanceof EntityNotFoundError)
      return reply.code(404).send({ code: error.code, message: error.message });
    if (error instanceof StaleVersionError)
      return reply.code(409).send({
        code: error.code,
        message: error.message,
        currentVersion: error.currentVersion,
      });
    if (error instanceof StaleTimerVersionError)
      return reply.code(409).send({
        code: error.code,
        message: error.message,
        currentVersion: error.currentVersion,
        currentTimer: error.currentTimer,
        serverTime: error.serverTime,
      });
    if (error instanceof TimerError) {
      const badRequest = new Set([
        'INVALID_TIMER_STATE',
        'TIMER_NOT_ELAPSED',
        'TIMER_ALREADY_ELAPSED',
        'INVALID_DAILY_TASK_STATE',
        'SERVER_TIME_MOVED_BACKWARDS',
      ]);
      const notFound = new Set(['TIMER_NOT_ACTIVE', 'DAILY_TASK_NOT_AVAILABLE']);
      const status = badRequest.has(error.code)
        ? 400
        : notFound.has(error.code)
          ? 404
          : 409;
      return reply.code(status).send({ code: error.code, message: error.message });
    }
    if (error instanceof InvalidConflictResolutionError)
      return reply.code(400).send(
        InvalidConflictResolutionErrorSchema.parse({
          code: error.code,
          message: error.message,
          conflictType: error.conflictType,
          resolution: error.resolution,
        }),
      );
    if (error instanceof ConflictAlreadyResolvedError)
      return reply.code(409).send(
        ConflictAlreadyResolvedErrorSchema.parse({
          code: error.code,
          message: error.message,
          resolution: error.resolution,
          resolutionResult: error.resolutionResult,
        }),
      );
    if (error instanceof ConflictResolutionTargetExistsError)
      return reply.code(409).send(
        ConflictResolutionTargetExistsErrorSchema.parse({
          code: error.code,
          message: error.message,
          entityId: error.entityId,
        }),
      );
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      if (error.statusCode === 429) {
        return reply
          .code(429)
          .send({ code: 'RATE_LIMITED', message: 'Too many login attempts' });
      }
      if (error.statusCode === 413) {
        return reply.code(413).send({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body is too large',
        });
      }
    }
    app.log.error(error);
    return reply
      .code(500)
      .send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  if (ownsDatabase) app.addHook('onClose', async () => connection.close());
  return app;
}
