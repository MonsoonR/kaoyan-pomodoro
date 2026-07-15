import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { openDatabase, type DatabaseConnection } from '../db/client';
import { migrateDatabase } from '../db/migrate';
import { initializeAccount } from './account-service';
import { TEST_PASSWORD_OPTIONS } from './password';

const origin = 'https://example.test';
const adminPassword = 'correct horse battery staple';
const userPassword = 'another correct battery staple';

describe('invitation registration and administration', () => {
  let database: DatabaseConnection;
  let app: Awaited<ReturnType<typeof createApp>>;
  let directory: string;
  let now: Date;
  let adminCookie: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'kaoyan-invites-'));
    database = openDatabase(join(directory, 'test.sqlite'));
    migrateDatabase(database.db);
    now = new Date('2026-07-15T08:00:00.000Z');
    await initializeAccount(database.sqlite, {
      username: 'Owner',
      password: adminPassword,
      confirmPassword: adminPassword,
    }, TEST_PASSWORD_OPTIONS);
    app = await createApp({
      database,
      appOrigin: origin,
      now: () => now,
      passwordOptions: TEST_PASSWORD_OPTIONS,
      logger: false,
      loginRateLimit: { max: 100, timeWindow: '1 minute' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'content-type': 'application/json' },
      payload: { username: ' owner ', password: adminPassword },
    });
    adminCookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterEach(async () => {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const createInvite = async (expiresInHours = 24) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: {
        cookie: adminCookie,
        origin,
        'content-type': 'application/json',
      },
      payload: { expiresInHours },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      invitation: { id: string; status: string };
      inviteUrl: string;
    }>();
    return {
      ...body,
      token: decodeURIComponent(body.inviteUrl.split('/#/invite/')[1] ?? ''),
    };
  };

  const register = (token: string, username: string) => app.inject({
    method: 'POST',
    url: '/api/auth/register-with-invite',
    headers: { origin, 'content-type': 'application/json' },
    payload: {
      token,
      username,
      password: userPassword,
      confirmPassword: userPassword,
    },
  });

  it('migrates the original account to admin and never lists token material', async () => {
    const me = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie },
    });
    expect(me.json().user.role).toBe('admin');
    const created = await createInvite();
    const list = await app.inject({
      method: 'GET', url: '/api/admin/invites', headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(created.token);
    expect(list.body).not.toMatch(/token_hash|inviteUrl/);
  });

  it('allows one registration and rejects every later use', async () => {
    const invite = await createInvite();
    const first = await register(invite.token, 'StudentOne');
    expect(first.statusCode).toBe(200);
    expect(first.json().user).toMatchObject({ role: 'user', username: 'StudentOne' });
    const second = await register(invite.token, 'StudentTwo');
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('INVITE_USED');
  });

  it('serializes concurrent registration so exactly one succeeds', async () => {
    const invite = await createInvite();
    const responses = await Promise.all([
      register(invite.token, 'ConcurrentOne'),
      register(invite.token, 'ConcurrentTwo'),
    ]);
    expect(responses.map((response) => response.statusCode).sort())
      .toEqual([200, 409]);
    expect(database.sqlite.prepare(
      `SELECT count(*) AS count FROM users WHERE role = 'user'`,
    ).get()).toEqual({ count: 1 });
  });

  it('rejects expired and revoked invites with distinct errors', async () => {
    const expired = await createInvite(1);
    now = new Date(now.getTime() + 60 * 60 * 1000 + 1);
    const expiredResponse = await register(expired.token, 'ExpiredUser');
    expect(expiredResponse.statusCode).toBe(410);
    expect(expiredResponse.json().code).toBe('INVITE_EXPIRED');

    now = new Date('2026-07-15T08:00:00.000Z');
    const revoked = await createInvite();
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/admin/invites/${revoked.invitation.id}/revoke`,
      headers: {
        cookie: adminCookie,
        origin,
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(revoke.statusCode).toBe(200);
    const revokedResponse = await register(revoked.token, 'RevokedUser');
    expect(revokedResponse.statusCode).toBe(409);
    expect(revokedResponse.json().code).toBe('INVITE_REVOKED');
  });

  it('does not consume an invite when username validation fails', async () => {
    const invite = await createInvite();
    const duplicate = await register(invite.token, 'ＯＷＮＥＲ');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('USERNAME_EXISTS');
    expect((await register(invite.token, 'AvailableName')).statusCode).toBe(200);
  });

  it('distinguishes password requirements without consuming the invite', async () => {
    const invite = await createInvite();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/auth/register-with-invite',
      headers: { origin, 'content-type': 'application/json' },
      payload: {
        token: invite.token,
        username: 'PasswordUser',
        password: 'too short',
        confirmPassword: 'too short',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('PASSWORD_REQUIREMENTS');
    expect((await register(invite.token, 'PasswordUser')).statusCode).toBe(200);
  });

  it('returns 403 to ordinary users on every administrator endpoint', async () => {
    const invite = await createInvite();
    const registered = await register(invite.token, 'OrdinaryUser');
    const userCookie = String(registered.headers['set-cookie']).split(';')[0] ?? '';
    for (const request of [
      { method: 'GET', url: '/api/admin/invites' },
      { method: 'POST', url: '/api/admin/invites', payload: { expiresInHours: 1 } },
      {
        method: 'POST',
        url: `/api/admin/invites/${invite.invitation.id}/revoke`,
        payload: {},
      },
    ] as const) {
      const response = await app.inject({
        ...request,
        headers: {
          cookie: userCookie,
          origin,
          ...('payload' in request
            ? { 'content-type': 'application/json' }
            : {}),
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ADMIN_REQUIRED');
    }
  });
});
