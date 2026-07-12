import {
  ChangePasswordRequestSchema,
  CurrentSessionSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  SuccessResponseSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { COOKIE_OPTIONS, SESSION_COOKIE_NAME } from '../auth/constants';
import {
  AuthFailure,
  authenticate,
  changePassword,
  login,
  type AuthenticatedSession,
  type Services,
} from '../auth/session-service';

declare module 'fastify' {
  interface FastifyRequest {
    authSession?: AuthenticatedSession;
  }
}

function requireAuthentication(services: Services) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = authenticate(services, request.cookies[SESSION_COOKIE_NAME]);
    if (!auth) {
      return reply.code(401).send({
        code: 'UNAUTHENTICATED',
        message: 'Authentication required',
      });
    }
    request.authSession = auth;
  };
}

function authenticatedSession(request: FastifyRequest): AuthenticatedSession {
  if (!request.authSession)
    throw new Error('Authentication pre-handler did not set a session');
  return request.authSession;
}

export async function authRoutes(
  app: FastifyInstance,
  services: Services,
  loginRateLimit: { max: number; timeWindow: string | number },
) {
  const authGuard = requireAuthentication(services);

  app.post(
    '/api/auth/login',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      try {
        const body = LoginRequestSchema.parse(request.body);
        const result = await login(
          services,
          body.username,
          body.password,
          request.headers['user-agent'] ?? '',
        );
        reply.setCookie(SESSION_COOKIE_NAME, result.token, COOKIE_OPTIONS);
        return LoginResponseSchema.parse({
          user: result.user,
          deviceId: result.deviceId,
          deviceName: result.deviceName,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof AuthFailure) {
          return reply.code(401).send({
            code: error.code,
            message: 'Invalid username or password',
          });
        }
        throw error;
      }
    },
  );

  app.get('/api/auth/me', { preHandler: authGuard }, async (request) => {
    const auth = authenticatedSession(request);
    return CurrentSessionSchema.parse({
      user: { id: auth.user_id, username: auth.username },
      deviceId: auth.device_id,
      deviceName: auth.device_name,
      expiresAt: new Date(auth.expires_at).toISOString(),
    });
  });

  app.post(
    '/api/auth/logout',
    { preHandler: authGuard },
    async (request, reply) => {
      const auth = authenticatedSession(request);
      services.sqlite
        .prepare(
          `
      UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `,
        )
        .run(services.now().getTime(), auth.session_id);
      reply.clearCookie(SESSION_COOKIE_NAME, COOKIE_OPTIONS);
      return SuccessResponseSchema.parse({ ok: true });
    },
  );

  app.post(
    '/api/auth/change-password',
    { preHandler: authGuard },
    async (request, reply) => {
      const body = ChangePasswordRequestSchema.parse(request.body);
      const auth = authenticatedSession(request);
      try {
        await changePassword(
          services,
          auth,
          body.currentPassword,
          body.newPassword,
        );
        return SuccessResponseSchema.parse({ ok: true });
      } catch (error) {
        if (error instanceof AuthFailure) {
          return reply.code(401).send({
            code: 'INVALID_CURRENT_PASSWORD',
            message: 'Current password is incorrect',
          });
        }
        throw error;
      }
    },
  );
}
