import type { FastifyInstance } from 'fastify';

import {
  getAuthenticatedSession,
  requireAuthentication,
} from '../auth/auth-hook';
import type { Services } from '../auth/session-service';
import { createUserDataExport } from '../services/export';

function exportFilename(exportedAt: Date): string {
  const safeTimestamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  return `kaoyan-pomodoro-export-${safeTimestamp}.json`;
}

export async function exportRoutes(app: FastifyInstance, services: Services) {
  const guard = requireAuthentication(services);

  app.get('/api/export', { preHandler: guard }, async (request, reply) => {
    const auth = getAuthenticatedSession(request);
    const exportedAt = services.now();
    const body = createUserDataExport(
      services.sqlite,
      auth.user_id,
      auth.device_id,
      exportedAt,
    );

    return reply
      .type('application/json; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="${exportFilename(exportedAt)}"`,
      )
      .send(body);
  });
}
