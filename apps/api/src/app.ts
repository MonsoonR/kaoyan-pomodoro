import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';

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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ code: 'VALIDATION_ERROR', message: 'Invalid request' });
    }
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
