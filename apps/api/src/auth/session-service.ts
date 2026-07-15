import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  LOCK_DURATION_MS,
  LOCK_FAILURES,
  SESSION_MAX_AGE_SECONDS,
} from './constants';
import { parseDevice } from './device';
import { hashPassword, type PasswordOptions, verifyPassword } from './password';
import { hashSessionToken } from './tokens';
import { normalizeUsername } from './username';

interface UserRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  status: 'active' | 'disabled';
  must_change_password: number;
  password_hash: string;
  failed_login_count: number;
  locked_until: number | null;
}

export interface AuthenticatedSession {
  session_id: string;
  user_id: string;
  device_id: string;
  expires_at: number;
  last_seen_at: number;
  username: string;
  role: 'admin' | 'user';
  must_change_password: number;
  device_name: string;
}

interface PasswordHashRow {
  password_hash: string;
}

export class AuthFailure extends Error {
  code = 'INVALID_CREDENTIALS';
}

export interface Services {
  sqlite: Database.Database;
  now: () => Date;
  token: () => string;
  passwordOptions: PasswordOptions;
  dummyPasswordHash: string;
  verifyPassword: typeof verifyPassword;
  appOrigin: string;
}

export function createSessionRecords(
  services: Services,
  user: Pick<UserRow, 'id' | 'username' | 'role' | 'must_change_password'>,
  userAgent: string,
  now: number,
) {
  const device = parseDevice(userAgent);
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const token = services.token();
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  services.sqlite.prepare(`
    INSERT INTO devices (
      id, user_id, name, browser, operating_system,
      last_active_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deviceId, user.id, device.name, device.browser, device.operatingSystem,
    now, now, now,
  );
  services.sqlite.prepare(`
    INSERT INTO sessions (
      id, user_id, device_id, token_hash, expires_at, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, user.id, deviceId, hashSessionToken(token), expiresAt, now, now,
  );
  return {
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: Boolean(user.must_change_password),
    },
    deviceId,
    deviceName: device.name,
    expiresAt: new Date(expiresAt),
  };
}

function recordFailedLogin(services: Services, userId: string, now: number) {
  services.sqlite.transaction(() => {
    services.sqlite
      .prepare(
        `
      UPDATE users
      SET
        failed_login_count = CASE
          WHEN locked_until IS NOT NULL AND locked_until <= ? THEN 1
          ELSE failed_login_count + 1
        END,
        last_failed_login_at = ?,
        locked_until = CASE
          WHEN locked_until IS NOT NULL AND locked_until <= ? THEN NULL
          WHEN failed_login_count + 1 >= ? THEN ?
          ELSE locked_until
        END
      WHERE id = ?
    `,
      )
      .run(now, now, now, LOCK_FAILURES, now + LOCK_DURATION_MS, userId);
  })();
}

export async function login(
  services: Services,
  username: string,
  password: string,
  userAgent: string,
) {
  const now = services.now().getTime();
  const user = services.sqlite
    .prepare(
      `
    SELECT id, username, password_hash, role, status, must_change_password,
      failed_login_count, locked_until
    FROM users
    WHERE normalized_username = ?
  `,
    )
    .get(normalizeUsername(username)) as UserRow | undefined;

  const passwordHash = user?.password_hash ?? services.dummyPasswordHash;
  const passwordIsValid = await services.verifyPassword(passwordHash, password);
  const isLocked =
    user?.locked_until !== null &&
    user?.locked_until !== undefined &&
    user.locked_until > now;

  if (!user || user.status !== 'active' || isLocked || !passwordIsValid) {
    if (user && !isLocked && !passwordIsValid)
      recordFailedLogin(services, user.id, now);
    throw new AuthFailure('Invalid username or password');
  }

  let result: ReturnType<typeof createSessionRecords>;
  services.sqlite.transaction(() => {
    result = createSessionRecords(services, user, userAgent, now);
    services.sqlite
      .prepare(
        `
      UPDATE users
      SET failed_login_count = 0,
          last_failed_login_at = NULL,
          locked_until = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, user.id);
  })();

  return result!;
}

export function authenticate(
  services: Services,
  token?: string,
): AuthenticatedSession | null {
  if (!token) return null;
  const now = services.now().getTime();
  const row = services.sqlite
    .prepare(
      `
    SELECT
      sessions.id AS session_id,
      sessions.user_id,
      sessions.device_id,
      sessions.expires_at,
      sessions.last_seen_at,
      users.username,
      users.role,
      users.must_change_password,
      devices.name AS device_name
    FROM sessions
    INNER JOIN users ON users.id = sessions.user_id
    INNER JOIN devices ON devices.id = sessions.device_id
    WHERE sessions.token_hash = ?
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > ?
      AND users.status = 'active'
  `,
    )
    .get(hashSessionToken(token), now) as AuthenticatedSession | undefined;
  if (!row) return null;

  if (now - row.last_seen_at > 300_000) {
    services.sqlite.transaction(() => {
      services.sqlite
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
        .run(now, row.session_id);
      services.sqlite
        .prepare(
          'UPDATE devices SET last_active_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(now, now, row.device_id);
    })();
  }
  return row;
}

export async function changePassword(
  services: Services,
  auth: AuthenticatedSession,
  currentPassword: string,
  newPassword: string,
) {
  const user = services.sqlite
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(auth.user_id) as PasswordHashRow;
  if (!(await services.verifyPassword(user.password_hash, currentPassword))) {
    throw new AuthFailure('Current password is incorrect');
  }

  const passwordHash = await hashPassword(
    newPassword,
    services.passwordOptions,
  );
  const now = services.now().getTime();
  services.sqlite.transaction(() => {
    services.sqlite
      .prepare(
        `
      UPDATE users
      SET password_hash = ?, password_changed_at = ?, updated_at = ?,
          must_change_password = false
      WHERE id = ?
    `,
      )
      .run(passwordHash, now, now, auth.user_id);
    services.sqlite
      .prepare(
        `
      UPDATE sessions
      SET revoked_at = ?
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
    `,
      )
      .run(now, auth.user_id, auth.session_id);
  })();
}
