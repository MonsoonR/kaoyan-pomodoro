import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { initializeAccount, resetAccountPassword } from './account-service';
import { TEST_PASSWORD_OPTIONS } from './password';
const origin = 'https://example.test',
  password = 'correct horse battery staple';
interface PasswordHashResult {
  password_hash: string;
}
interface TokenHashResult {
  token_hash: string;
}
interface CountResult {
  n: number;
}
interface DeviceNameResult {
  name: string;
}
let database: DatabaseConnection;
let app: Awaited<ReturnType<typeof createApp>>;
let now: Date;
let testDirectory: string;
beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'kaoyan-auth-'));
  database = openDatabase(join(testDirectory, 'test.sqlite'));
  migrateDatabase(database.db);
  now = new Date('2026-07-12T10:00:00Z');
  await initializeAccount(
    database.sqlite,
    { username: 'learner', password, confirmPassword: password },
    TEST_PASSWORD_OPTIONS,
  );
  app = await createApp({
    database,
    appOrigin: origin,
    now: () => now,
    passwordOptions: TEST_PASSWORD_OPTIONS,
    logger: false,
    loginRateLimit: { max: 20, timeWindow: '1 minute' },
  });
});
afterEach(async () => {
  if (app) await app.close();
  if (database?.sqlite.open) database.close();
  if (testDirectory) rmSync(testDirectory, { recursive: true, force: true });
});
const login = (
  value = password,
  ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/126.0',
) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, 'content-type': 'application/json', 'user-agent': ua },
    payload: { username: 'learner', password: value },
  });
const cookie = (response: Awaited<ReturnType<typeof login>>) =>
  String(response.headers['set-cookie']).split(';')[0] ?? '';
describe('authentication API', () => {
  it('initializes Argon2id account and default settings without plaintext', () => {
    const user = database.sqlite
      .prepare('select password_hash from users')
      .get() as PasswordHashResult;
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.password_hash).not.toContain(password);
    expect(
      database.sqlite.prepare('select count(*) n from settings').get(),
    ).toEqual({ n: 1 });
  });
  it('rejects a second account initialization', async () => {
    await expect(
      initializeAccount(
        database.sqlite,
        { username: 'other', password, confirmPassword: password },
        TEST_PASSWORD_OPTIONS,
      ),
    ).rejects.toThrow('already initialized');
  });
  it('logs in and stores only the token hash with a secure thirty-day cookie', async () => {
    const response = await login();
    expect(response.statusCode).toBe(200);
    const set = String(response.headers['set-cookie']);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Lax');
    expect(set).toContain('Path=/');
    expect(set).toContain('Max-Age=2592000');
    const raw = cookie(response).split('=')[1] ?? '';
    const row = database.sqlite
      .prepare('select token_hash from sessions')
      .get() as TokenHashResult;
    expect(row.token_hash).not.toBe(raw);
    expect(response.body).not.toMatch(/hash|token|password/i);
  });
  it('uses one generic error for wrong username and password', async () => {
    const wrong = await login('wrong password!');
    const missing = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'missing', password: 'wrong password!' },
    });
    expect(wrong.json()).toEqual(missing.json());
  });
  it('returns the same response for a missing user, wrong password, and locked account', async () => {
    const wrongPassword = await login('wrong password!');
    const missingUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: 'missing', password },
    });
    database.sqlite
      .prepare('update users set locked_until = ?')
      .run(now.getTime() + 60_000);
    const lockedAccount = await login();
    expect([
      wrongPassword.statusCode,
      missingUser.statusCode,
      lockedAccount.statusCode,
    ]).toEqual([401, 401, 401]);
    expect(missingUser.json()).toEqual(wrongPassword.json());
    expect(lockedAccount.json()).toEqual(wrongPassword.json());
  });
  it('supports two simultaneous devices and current account lookup', async () => {
    const a = await login(password, 'Chrome/126.0 Windows');
    const b = await login(password, 'Firefox/125.0 Linux');
    expect(
      (
        database.sqlite
          .prepare('select count(*) n from sessions where revoked_at is null')
          .get() as CountResult
      ).n,
    ).toBe(2);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: cookie(a) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toMatch(/hash|locked/i);
    const devices = await app.inject({
      method: 'GET',
      url: '/api/devices',
      headers: { cookie: cookie(b) },
    });
    expect(devices.json().devices).toHaveLength(2);
  });
  it('revokes current session and clears matching secure cookie', async () => {
    const a = await login();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        origin,
        'content-type': 'application/json',
        cookie: cookie(a),
      },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toMatch(
      /kaoyan_session=;.*Path=\/.*HttpOnly.*Secure.*SameSite=Lax/,
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(a) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('locks after five failures for fifteen minutes then resets on success', async () => {
    for (let i = 0; i < 5; i++)
      expect((await login('wrong password!')).statusCode).toBe(401);
    expect((await login()).statusCode).toBe(401);
    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    expect((await login()).statusCode).toBe(200);
    expect(
      database.sqlite
        .prepare('select failed_login_count,locked_until from users')
        .get(),
    ).toEqual({ failed_login_count: 0, locked_until: null });
  });
  it('changes password while preserving only current session', async () => {
    const a = await login();
    await login();
    const next = 'new secure password 123';
    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: {
        origin,
        'content-type': 'application/json',
        cookie: cookie(a),
      },
      payload: {
        currentPassword: password,
        newPassword: next,
        confirmPassword: next,
      },
    });
    expect(changed.statusCode).toBe(200);
    expect((await login()).statusCode).toBe(401);
    expect((await login(next)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(a) },
        })
      ).statusCode,
    ).toBe(200);
  });
  it('CLI reset business function revokes every session', async () => {
    await login();
    await resetAccountPassword(
      database.sqlite,
      'reset password 123',
      'reset password 123',
      TEST_PASSWORD_OPTIONS,
    );
    expect(
      (
        database.sqlite
          .prepare('select count(*) n from sessions where revoked_at is null')
          .get() as CountResult
      ).n,
    ).toBe(0);
  });
  it('enforces exact origin and JSON on writes but not reads', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: {
            origin: 'https://evil.test',
            'content-type': 'application/json',
          },
          payload: { username: 'learner', password },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin, 'content-type': 'text/plain' },
          payload: 'x',
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode,
    ).toBe(401);
  });
  it('rejects revoked and expired sessions', async () => {
    const a = await login();
    database.sqlite
      .prepare('update sessions set revoked_at=?')
      .run(now.getTime());
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(a) },
        })
      ).statusCode,
    ).toBe(401);
    const b = await login();
    database.sqlite
      .prepare('update sessions set expires_at=? where revoked_at is null')
      .run(now.getTime());
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(b) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('renames and revokes another device without deleting it', async () => {
    const current = await login(password, 'Chrome/126 Windows');
    const other = await login(password, 'Firefox/125 Linux');
    const otherId = other.json().deviceId;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/devices/${otherId}`,
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: cookie(current),
          },
          payload: { name: 'Library laptop' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        database.sqlite
          .prepare('select name from devices where id=?')
          .get(otherId) as DeviceNameResult
      ).name,
    ).toBe('Library laptop');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/devices/${otherId}`,
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: cookie(current),
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/devices/${otherId}`,
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: cookie(current),
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      database.sqlite.prepare('select id from devices where id=?').get(otherId),
    ).toBeTruthy();
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(other) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('does not allow the device endpoint to revoke the current device', async () => {
    const current = await login();
    const id = current.json().deviceId;
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/devices/${id}`,
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: cookie(current),
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
  });
  it('logs out all other devices while retaining the current session', async () => {
    const current = await login();
    const other = await login();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/devices/logout-others',
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: cookie(current),
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(current) },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/auth/me',
          headers: { cookie: cookie(other) },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('rate limits login by IP with an injectable threshold', async () => {
    await app.close();
    app = await createApp({
      database,
      appOrigin: origin,
      logger: false,
      passwordOptions: TEST_PASSWORD_OPTIONS,
      loginRateLimit: { max: 2, timeWindow: '1 minute' },
    });
    expect((await login('wrong password!')).statusCode).toBe(401);
    expect((await login('wrong password!')).statusCode).toBe(401);
    const limited = await login('wrong password!');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('RATE_LIMITED');
  });
  it('starts a fresh failure cycle after a lock expires', async () => {
    for (let i = 0; i < 5; i++) await login('wrong password!');
    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    for (let i = 1; i <= 4; i++) {
      expect((await login('wrong password!')).statusCode).toBe(401);
      const row = database.sqlite
        .prepare('select failed_login_count,locked_until from users')
        .get() as { failed_login_count: number; locked_until: number | null };
      expect(row.failed_login_count).toBe(i);
      expect(row.locked_until).toBeNull();
    }
    expect((await login('wrong password!')).statusCode).toBe(401);
    const relocked = database.sqlite
      .prepare('select failed_login_count,locked_until from users')
      .get() as { failed_login_count: number; locked_until: number | null };
    expect(relocked.failed_login_count).toBe(5);
    expect(relocked.locked_until).toBe(now.getTime() + 15 * 60 * 1000);
    expect((await login()).statusCode).toBe(401);
    expect(
      (
        database.sqlite.prepare('select locked_until from users').get() as {
          locked_until: number;
        }
      ).locked_until,
    ).toBe(relocked.locked_until);
    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    expect((await login()).statusCode).toBe(200);
    expect(
      database.sqlite
        .prepare('select failed_login_count,locked_until from users')
        .get(),
    ).toEqual({ failed_login_count: 0, locked_until: null });
  });
});
