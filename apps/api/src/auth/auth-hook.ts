import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME } from './constants';
import {
  authenticate,
  type AuthenticatedSession,
  type Services,
} from './session-service';

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: AuthenticatedSession;
  }
}
export function requireAuthentication(services: Services) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(services, request.cookies[SESSION_COOKIE_NAME]);
    if (!auth)
      return reply
        .code(401)
        .send({ code: 'UNAUTHENTICATED', message: 'Authentication required' });
    request.authSession = auth;
  };
}

export function requireAdministrator(services: Services) {
  const authenticateRequest = requireAuthentication(services);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await authenticateRequest(request, reply);
    if (reply.sent) return;
    if (request.authSession?.role !== 'admin') {
      return reply.code(403).send({
        code: 'ADMIN_REQUIRED',
        message: 'Administrator permission required',
      });
    }
  };
}
export function getAuthenticatedSession(
  request: FastifyRequest,
): AuthenticatedSession {
  if (!request.authSession)
    throw new Error('Authentication pre-handler did not set a session');
  return request.authSession;
}
