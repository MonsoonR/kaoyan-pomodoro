import {
  OperationReceiptSchema,
  PullChangesQuerySchema,
  PullChangesResponseSchema,
  PushOperationsRequestSchema,
  PushOperationsResponseSchema,
  SyncOperationSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  getAuthenticatedSession,
  requireAuthentication,
} from '../auth/auth-hook';
import type { Services } from '../auth/session-service';
import { latestCursor, pullChanges } from '../sync/pull';
import { createSyncProcessor } from '../sync/processor';

// 100 operations with maximum-length task notes are approximately 520 KiB.
const SYNC_BODY_LIMIT = 768 * 1024;
export async function syncRoutes(app: FastifyInstance, services: Services) {
  const guard = requireAuthentication(services);
  const processor = createSyncProcessor(services);
  app.post(
    '/api/sync/push',
    { preHandler: guard, bodyLimit: SYNC_BODY_LIMIT },
    async (request) => {
      const auth = getAuthenticatedSession(request);
      const body = PushOperationsRequestSchema.parse(request.body);
      const receipts = body.operations.map((raw, index) => {
        const parsed = SyncOperationSchema.safeParse(raw);
        if (!parsed.success)
          return OperationReceiptSchema.parse({
            operationId: null,
            index,
            status: 'rejected',
            entityVersion: null,
            conflictId: null,
            errorCode: 'MALFORMED_OPERATION',
            errorMessage: 'Operation is malformed',
          });
        return processor.process(parsed.data, auth.user_id, auth.device_id);
      });
      return PushOperationsResponseSchema.parse({
        receipts,
        latestCursor: latestCursor(services.sqlite, auth.user_id),
      });
    },
  );
  app.get('/api/sync/pull', { preHandler: guard }, async (request) => {
    const auth = getAuthenticatedSession(request);
    const query = PullChangesQuerySchema.parse(request.query);
    return PullChangesResponseSchema.parse(
      pullChanges(services.sqlite, auth.user_id, query.cursor, query.limit),
    );
  });
}
