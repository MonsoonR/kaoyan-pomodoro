import {
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  InvitationIdParamsSchema,
  InvitationListResponseSchema,
  InvitationSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  getAuthenticatedSession,
  requireAdministrator,
} from '../auth/auth-hook';
import { createInvitationService } from '../auth/invitation-service';
import type { Services } from '../auth/session-service';

export async function adminInviteRoutes(
  app: FastifyInstance,
  services: Services,
) {
  const guard = requireAdministrator(services);
  const invitations = createInvitationService(services);

  app.get('/api/admin/invites', { preHandler: guard }, async () =>
    InvitationListResponseSchema.parse({ invitations: invitations.list() }),
  );

  app.post('/api/admin/invites', { preHandler: guard }, async (request) => {
    const auth = getAuthenticatedSession(request);
    const body = CreateInvitationRequestSchema.parse(request.body);
    return CreateInvitationResponseSchema.parse(
      invitations.create(auth.user_id, body.expiresInHours),
    );
  });

  app.post(
    '/api/admin/invites/:invitationId/revoke',
    { preHandler: guard },
    async (request) => {
      const { invitationId } = InvitationIdParamsSchema.parse(request.params);
      return InvitationSchema.parse(invitations.revoke(invitationId));
    },
  );
}
