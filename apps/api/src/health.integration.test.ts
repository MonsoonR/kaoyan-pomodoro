import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './app';
import { openDatabase, type DatabaseConnection } from './db/client';
import { migrateDatabase } from './db/migrate';

const connections: DatabaseConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    if (connection.sqlite.open) connection.close();
  }
});

async function appWithDatabase() {
  const database = openDatabase(':memory:');
  connections.push(database);
  migrateDatabase(database.db);
  const app = await createApp({
    database,
    appOrigin: 'https://pomodoro.example.com',
    logger: false,
  });
  return { app, database };
}

describe('health endpoints', () => {
  it('serves liveness without authentication or an Origin header', async () => {
    const { app } = await appWithDatabase();
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('reports ready after migrations and a lightweight SQLite check', async () => {
    const { app } = await appWithDatabase();
    const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns a safe 503 response when SQLite is unavailable', async () => {
    const { app, database } = await appWithDatabase();
    database.close();
    const response = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      code: 'NOT_READY',
      message: 'Service is not ready',
    });
    expect(response.body).not.toMatch(/sqlite|database|select|pragma|path/i);
    await app.close();
  });
});
