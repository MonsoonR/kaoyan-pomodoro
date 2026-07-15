import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  LoginRequestSchema,
  PasswordSchema,
  SettingsSchema,
  UsernameSchema,
} from '@kaoyan/contracts';
import {
  hashPassword,
  type PasswordOptions,
  PRODUCTION_PASSWORD_OPTIONS,
} from './password';
import { normalizeUsername } from './username';

export function insertInitialSettings(
  sqlite: Database.Database,
  userId: string,
  now: number,
) {
  const settingsId = randomUUID();
  const settingsPayload = SettingsSchema.parse({
    id: settingsId,
    defaultPreset: '50-10',
    customFocusMinutes: 40,
    customShortBreakMinutes: 8,
    customLongBreakMinutes: 20,
    longBreakInterval: 4,
    soundEnabled: true,
    notificationsEnabled: false,
    version: 1,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    deletedAt: null,
  });
  sqlite.prepare(
    'insert into settings (id,user_id,created_at,updated_at) values (?,?,?,?)',
  ).run(settingsId, userId, now, now);
  sqlite.prepare(
    `insert into sync_changes (user_id,entity_type,entity_id,version,change_type,payload,changed_at) values (?,'settings',?,1,'upsert',?,?)`,
  ).run(userId, settingsId, JSON.stringify(settingsPayload), now);
}

export async function initializeAccount(
  sqlite: Database.Database,
  input: { username: string; password: string; confirmPassword: string },
  options: PasswordOptions = PRODUCTION_PASSWORD_OPTIONS,
) {
  const username = UsernameSchema.parse(input.username);
  const normalizedUsername = normalizeUsername(username);
  const password = PasswordSchema.parse(input.password);
  if (password !== input.confirmPassword)
    throw new Error('Passwords do not match');
  if (sqlite.prepare('select 1 from users limit 1').get())
    throw new Error('Account already initialized');
  const passwordHash = await hashPassword(password, options);
  const now = Date.now();
  const userId = randomUUID();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `insert into users (
          id,singleton_key,username,normalized_username,password_hash,role,status,
          must_change_password,password_changed_at,created_at,updated_at
        ) values (?,1,?,?,?,'admin','active',false,?,?,?)`,
      )
      .run(userId, username, normalizedUsername, passwordHash, now, now, now);
    insertInitialSettings(sqlite, userId, now);
  })();
  return { id: userId, username, role: 'admin' as const };
}

export async function resetAccountPassword(
  sqlite: Database.Database,
  username: string,
  password: string,
  confirmPassword: string,
  options: PasswordOptions = PRODUCTION_PASSWORD_OPTIONS,
) {
  PasswordSchema.parse(password);
  if (password !== confirmPassword) throw new Error('Passwords do not match');
  const parsedUsername = UsernameSchema.parse(username);
  const normalizedUsername = normalizeUsername(parsedUsername);
  const user = sqlite
    .prepare('select id from users where normalized_username = ?')
    .get(normalizedUsername) as
    | { id: string }
    | undefined;
  if (!user) throw new Error('User not found');
  const hash = await hashPassword(password, options);
  const now = Date.now();
  sqlite.transaction(() => {
    sqlite
      .prepare(
        'update users set password_hash=?,password_changed_at=?,updated_at=?,must_change_password=true,failed_login_count=0,last_failed_login_at=null,locked_until=null where id=?',
      )
      .run(hash, now, now, user.id);
    sqlite
      .prepare(
        'update sessions set revoked_at=? where user_id=? and revoked_at is null',
      )
      .run(now, user.id);
  })();
}

export function validateLogin(input: unknown) {
  return LoginRequestSchema.parse(input);
}
