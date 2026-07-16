import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { initializeAccount, resetAccountPassword } from '../auth/account-service';
import { openDatabase } from '../db/client';
import { resolveDatabaseSource } from '../db/database-source';
import { migrateDatabase } from '../db/migrate';
import { promptHidden } from './prompt-password';

type Input = { username: string | undefined; password: string; confirmPassword: string };

export function getAccountInitializationStatus(source: string) {
  const sqlite = new Database(source, { readonly: true, fileMustExist: true });
  try {
    const row = sqlite
      .prepare('SELECT EXISTS(SELECT 1 FROM users) AS initialized')
      .get() as { initialized: 0 | 1 };
    return row.initialized === 1;
  } finally {
    sqlite.close();
  }
}

async function readInput(
  command: string,
  resetUsername?: string,
): Promise<Input> {
  if (process.env.KAOYAN_ACCOUNT_STDIN === '1') {
    const parsed = JSON.parse(readFileSync(0, 'utf8')) as Partial<Input>;
    if (typeof parsed.password !== 'string' || typeof parsed.confirmPassword !== 'string' ||
        (command === 'init' && typeof parsed.username !== 'string'))
      throw new Error('Invalid account input from stdin');
    return {
      username: command === 'reset-password' ? resetUsername : parsed.username,
      password: parsed.password,
      confirmPassword: parsed.confirmPassword,
    } as Input;
  }
  let username: string | undefined = resetUsername;
  if (command === 'init') {
    const readline = createInterface({ input: stdin, output: stdout });
    try { username = await readline.question('Username: '); }
    finally { readline.close(); }
  }
  const password = await promptHidden('New password: ');
  const confirmPassword = await promptHidden('Confirm password: ');
  return { username, password, confirmPassword };
}

async function main() {
  const command = process.argv[2];
  if (command !== 'init' && command !== 'reset-password' && command !== 'status')
    throw new Error('Use init, reset-password or status');
  const extra = process.argv.slice(3);
  let resetUsername: string | undefined;
  if (command === 'init' && extra.length !== 0)
    throw new Error('Account data must not be passed as command arguments');
  if (command === 'reset-password') {
    if (extra.length !== 2 || extra[0] !== '--username' || !extra[1])
      throw new Error('Use reset-password --username <username>');
    resetUsername = extra[1];
  }
  const path = process.env.DATABASE_PATH;
  if (!path) throw new Error('DATABASE_PATH is required');
  const source = resolveDatabaseSource(path);
  if (command === 'status') {
    if (extra.length !== 0) throw new Error('Use status without account arguments');
    stdout.write(getAccountInitializationStatus(source) ? 'initialized\n' : 'not-initialized\n');
    return;
  }

  const connection = openDatabase(source);
  try {
    const input = await readInput(command, resetUsername);
    migrateDatabase(connection.db);
    if (command === 'init') {
      await initializeAccount(connection.sqlite, {
        username: input.username ?? '',
        password: input.password,
        confirmPassword: input.confirmPassword,
      });
    } else {
      await resetAccountPassword(
        connection.sqlite,
        input.username ?? '',
        input.password,
        input.confirmPassword,
      );
    }
    stdout.write('Account updated successfully.\n');
  } finally {
    connection.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
