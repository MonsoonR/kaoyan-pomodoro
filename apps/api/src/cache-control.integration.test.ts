import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { initializeAccount } from './auth/account-service';
import { TEST_PASSWORD_OPTIONS } from './auth/password';
import { openDatabase, type DatabaseConnection } from './db/client';
import { migrateDatabase } from './db/migrate';

const origin = 'https://pomodoro.example.test';
const password = 'correct horse battery staple';
let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof createApp>>;
let cookie: string;

beforeEach(async () => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db);
  await initializeAccount(
    database.sqlite,
    { username: 'learner', password, confirmPassword: password },
    TEST_PASSWORD_OPTIONS,
  );
  app = await createApp({
    database,
    appOrigin: origin,
    passwordOptions: TEST_PASSWORD_OPTIONS,
    loginRateLimit: { max: 3, timeWindow: '1 minute' },
    logger: false,
  });
  app.get('/api/testing/error', async () => {
    throw new Error('test-only failure');
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, 'content-type': 'application/json' },
    payload: { username: 'learner', password },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
});

afterEach(async () => {
  await app.close();
  if (database.sqlite.open) database.close();
});

const expectNoStore = (response: { headers: Record<string, unknown> }) => {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers.pragma).toBe('no-cache');
};

describe('API HTTP cache prevention', () => {
  it('marks health, session, sync, timer and export success responses no-store', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/api/health/live' }),
      app.inject({ method: 'GET', url: '/api/health/ready' }),
      app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }),
      app.inject({ method: 'GET', url: '/api/sync/pull?cursor=0&limit=1', headers: { cookie } }),
      app.inject({ method: 'GET', url: '/api/timer', headers: { cookie } }),
      app.inject({ method: 'GET', url: '/api/export', headers: { cookie } }),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    responses.forEach(expectNoStore);
  });

  it('marks authentication, origin, rate-limit and internal errors no-store', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/sync/push',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json', cookie },
      payload: { operations: [] },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin, 'content-type': 'application/json' },
        payload: { username: 'learner', password: 'wrong password' },
      });
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'learner', password: 'wrong password' },
    });
    const internal = await app.inject({ method: 'GET', url: '/api/testing/error' });
    expect([
      unauthorized.statusCode,
      forbidden.statusCode,
      limited.statusCode,
      internal.statusCode,
    ]).toEqual([401, 403, 429, 500]);
    [unauthorized, forbidden, limited, internal].forEach(expectNoStore);
  });
});
