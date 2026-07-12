import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { LoginRequestSchema, PasswordSchema, UsernameSchema } from '@kaoyan/contracts';
import { hashPassword, type PasswordOptions, PRODUCTION_PASSWORD_OPTIONS } from './password';

export async function initializeAccount(sqlite: Database.Database, input: { username: string; password: string; confirmPassword: string }, options: PasswordOptions = PRODUCTION_PASSWORD_OPTIONS) {
  const username = UsernameSchema.parse(input.username);
  const password = PasswordSchema.parse(input.password);
  if (password !== input.confirmPassword) throw new Error('Passwords do not match');
  if (sqlite.prepare('select 1 from users limit 1').get()) throw new Error('Account already initialized');
  const passwordHash = await hashPassword(password, options);
  const now = Date.now(); const userId = randomUUID();
  sqlite.transaction(() => {
    sqlite.prepare('insert into users (id,singleton_key,username,password_hash,password_changed_at,created_at,updated_at) values (?,1,?,?,?,?,?)').run(userId, username, passwordHash, now, now, now);
    sqlite.prepare('insert into settings (id,user_id,created_at,updated_at) values (?,?,?,?)').run(randomUUID(), userId, now, now);
  })();
  return { id: userId, username };
}

export async function resetAccountPassword(sqlite: Database.Database, password: string, confirmPassword: string, options: PasswordOptions = PRODUCTION_PASSWORD_OPTIONS) {
  PasswordSchema.parse(password); if (password !== confirmPassword) throw new Error('Passwords do not match');
  const user = sqlite.prepare('select id from users limit 1').get() as { id: string } | undefined;
  if (!user) throw new Error('Account is not initialized');
  const hash = await hashPassword(password, options); const now = Date.now();
  sqlite.transaction(() => {
    sqlite.prepare('update users set password_hash=?,password_changed_at=?,updated_at=?,failed_login_count=0,last_failed_login_at=null,locked_until=null where id=?').run(hash, now, now, user.id);
    sqlite.prepare('update sessions set revoked_at=? where user_id=? and revoked_at is null').run(now, user.id);
  })();
}

export function validateLogin(input: unknown) { return LoginRequestSchema.parse(input); }
