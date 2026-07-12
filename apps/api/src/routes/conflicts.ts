import {
  ConflictIdParamsSchema,
  ConflictListResponseSchema,
  ConflictSchema,
  ResolveConflictRequestSchema,
  ResolveConflictResponseSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  getAuthenticatedSession,
  requireAuthentication,
} from '../auth/auth-hook';
import type { Services } from '../auth/session-service';
import { createConflictService } from '../sync/conflicts';
export async function conflictRoutes(app: FastifyInstance, services: Services) {
  const guard = requireAuthentication(services),
    service = createConflictService(services);
  const user = (request: Parameters<typeof getAuthenticatedSession>[0]) =>
    getAuthenticatedSession(request).user_id;
  app.get('/api/conflicts', { preHandler: guard }, async (request) =>
    ConflictListResponseSchema.parse(service.list(user(request))),
  );
  app.get(
    '/api/conflicts/:conflictId',
    { preHandler: guard },
    async (request) =>
      ConflictSchema.parse(
        service.get(
          user(request),
          ConflictIdParamsSchema.parse(request.params).conflictId,
        ),
      ),
  );
  app.post(
    '/api/conflicts/:conflictId/resolve',
    { preHandler: guard },
    async (request) =>
      ResolveConflictResponseSchema.parse(
        service.resolve(
          user(request),
          ConflictIdParamsSchema.parse(request.params).conflictId,
          ResolveConflictRequestSchema.parse(request.body),
        ),
      ),
  );
}
