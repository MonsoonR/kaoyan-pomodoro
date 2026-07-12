import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CurrentSessionSchema,
  DeviceListResponseSchema,
  LoginResponseSchema,
  SuccessResponseSchema,
} from '@kaoyan/contracts';

import { createApp } from '../app';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { initializeAccount } from './account-service';
import { TEST_PASSWORD_OPTIONS } from './password';
import { login, type Services } from './session-service';

const origin = 'https://example.test';
const password = 'correct horse battery staple';
let directory: string;
let database: DatabaseConnection;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'kaoyan-hardening-'));
  database = openDatabase(join(directory, 'test.sqlite'));
  migrateDatabase(database.db);
  await initializeAccount(
    database.sqlite,
    { username: 'learner', password, confirmPassword: password },
    TEST_PASSWORD_OPTIONS,
  );
});

afterEach(() => {
  if (database.sqlite.open) database.close();
  rmSync(directory, { recursive: true, force: true });
});

const requestLogin = (
  app: Awaited<ReturnType<typeof createApp>>,
  forwardedFor: string,
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    remoteAddress: '127.0.0.1',
    headers: {
      origin,
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor,
    },
    payload: { username: 'learner', password: 'wrong password!' },
  });

describe('proxy-aware login rate limiting', () => {
  it('separates clients behind one trusted proxy while sharing limits for the same forwarded IP', async () => {
    const app = await createApp({
      database,
      appOrigin: origin,
      logger: false,
      trustProxy: 1,
      loginRateLimit: { max: 1, timeWindow: '1 minute' },
      passwordOptions: TEST_PASSWORD_OPTIONS,
    });
    expect((await requestLogin(app, '198.51.100.10')).statusCode).toBe(401);
    expect((await requestLogin(app, '198.51.100.10')).statusCode).toBe(429);
    expect((await requestLogin(app, '203.0.113.20')).statusCode).toBe(401);
    await app.close();
  });

  it('does not trust spoofed forwarded IPs by default', async () => {
    const app = await createApp({
      database,
      appOrigin: origin,
      logger: false,
      loginRateLimit: { max: 1, timeWindow: '1 minute' },
      passwordOptions: TEST_PASSWORD_OPTIONS,
    });
    expect((await requestLogin(app, '198.51.100.10')).statusCode).toBe(401);
    expect((await requestLogin(app, '203.0.113.20')).statusCode).toBe(429);
    await app.close();
  });
});

describe('constant password verification work', () => {
  it.each([
    ['normal account', 'learner', null],
    ['missing account', 'missing', null],
    ['locked account', 'learner', Date.now() + 60_000],
  ])(
    'calls verify exactly once for a %s',
    async (_case, username, lockedUntil) => {
      if (lockedUntil) {
        database.sqlite
          .prepare('update users set locked_until = ?')
          .run(lockedUntil);
      }
      const verify = vi.fn().mockResolvedValue(false);
      const services = {
        sqlite: database.sqlite,
        now: () => new Date(),
        token: () => 'token',
        passwordOptions: TEST_PASSWORD_OPTIONS,
        dummyPasswordHash: '$argon2id$dummy',
        verifyPassword: verify,
      } as Services;
      await expect(login(services, username, password, '')).rejects.toThrow();
      expect(verify).toHaveBeenCalledTimes(1);
    },
  );
});

describe('request body boundary', () => {
  it('rejects JSON bodies larger than 64 KiB', async () => {
    const app = await createApp({
      database,
      appOrigin: origin,
      logger: false,
      passwordOptions: TEST_PASSWORD_OPTIONS,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'learner', password: 'x'.repeat(70 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    await app.close();
  });
});

describe('runtime route contracts', () => {
  it('validates authentication, device list, and success responses', async () => {
    const app = await createApp({
      database,
      appOrigin: origin,
      logger: false,
      passwordOptions: TEST_PASSWORD_OPTIONS,
    });
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'learner', password },
    });
    expect(LoginResponseSchema.parse(loginResponse.json())).toEqual(
      loginResponse.json(),
    );
    const sessionCookie =
      String(loginResponse.headers['set-cookie']).split(';')[0] ?? '';

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: sessionCookie },
    });
    expect(CurrentSessionSchema.parse(meResponse.json())).toEqual(
      meResponse.json(),
    );

    const devicesResponse = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: sessionCookie },
    });
    expect(DeviceListResponseSchema.parse(devicesResponse.json())).toEqual(
      devicesResponse.json(),
    );

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        origin,
        'content-type': 'application/json',
        cookie: sessionCookie,
      },
      payload: {},
    });
    expect(SuccessResponseSchema.parse(logoutResponse.json())).toEqual({
      ok: true,
    });
    await app.close();
  });

  it.each(['PATCH', 'DELETE'] as const)(
    'rejects an invalid device UUID on %s',
    async (method) => {
      const app = await createApp({
        database,
        appOrigin: origin,
        logger: false,
        passwordOptions: TEST_PASSWORD_OPTIONS,
      });
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, 'content-type': 'application/json' },
        payload: { username: 'learner', password },
      });
      const sessionCookie =
        String(loginResponse.headers['set-cookie']).split(';')[0] ?? '';
      const response = await app.inject({
        method,
        url: '/api/devices/not-a-uuid',
        headers: {
          origin,
          'content-type': 'application/json',
          cookie: sessionCookie,
        },
        payload: method === 'PATCH' ? { name: 'Desk' } : {},
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
      });
      await app.close();
    },
  );
});
