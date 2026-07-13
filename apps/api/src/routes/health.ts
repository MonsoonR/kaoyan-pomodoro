import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

export async function healthRoutes(app: FastifyInstance, sqlite: Database.Database) {
  app.get('/api/health/live', async () => ({ status: 'ok' }));

  app.get('/api/health/ready', async (_request, reply) => {
    try {
      sqlite.prepare('SELECT 1 AS value').get();
      const migrations = sqlite.prepare(
        "SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      ).get() as { value?: number } | undefined;
      if (migrations?.value !== 1) throw new Error('Migrations are not installed');
      const result = sqlite.pragma('quick_check(1)', { simple: true });
      if (result !== 'ok') throw new Error('SQLite quick check failed');
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'Readiness check failed');
      return reply.code(503).send({
        status: 'error',
        code: 'NOT_READY',
        message: 'Service is not ready',
      });
    }
  });
}
