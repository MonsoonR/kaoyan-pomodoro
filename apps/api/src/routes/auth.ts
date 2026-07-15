import {
  ChangePasswordRequestSchema,
  CurrentSessionSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RegisterWithInviteRequestSchema,
  RegisterWithInviteResponseSchema,
  SuccessResponseSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';

import { COOKIE_OPTIONS, SESSION_COOKIE_NAME } from '../auth/constants';
import {
  AuthFailure,
  changePassword,
  login,
  type Services,
} from '../auth/session-service';
import { getAuthenticatedSession, requireAuthentication } from '../auth/auth-hook';
import { createInvitationService } from '../auth/invitation-service';

export async function authRoutes(
  app: FastifyInstance,
  services: Services,
  loginRateLimit: { max: number; timeWindow: string | number },
) {
  const authGuard = requireAuthentication(services);
  const invitations = createInvitationService(services);

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

  app.post(
    '/api/auth/register-with-invite',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      const parsed = RegisterWithInviteRequestSchema.safeParse(request.body);
      if (!parsed.success && parsed.error.issues.some((issue) =>
        issue.path[0] === 'password' || issue.path[0] === 'confirmPassword')) {
        return reply.code(400).send({
          code: 'PASSWORD_REQUIREMENTS',
          message: 'Password does not meet requirements',
        });
      }
      if (!parsed.success) throw parsed.error;
      const body = parsed.data;
      const result = await invitations.register(
        body,
        request.headers['user-agent'] ?? '',
      );
      reply.header('Referrer-Policy', 'no-referrer');
      reply.setCookie(SESSION_COOKIE_NAME, result.token, COOKIE_OPTIONS);
      return RegisterWithInviteResponseSchema.parse({
        user: result.user,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.get('/api/auth/me', { preHandler: authGuard }, async (request) => {
    const auth = getAuthenticatedSession(request);
    return CurrentSessionSchema.parse({
      user: {
        id: auth.user_id,
        username: auth.username,
        role: auth.role,
        mustChangePassword: Boolean(auth.must_change_password),
      },
      deviceId: auth.device_id,
      deviceName: auth.device_name,
      expiresAt: new Date(auth.expires_at).toISOString(),
    });
  });

  app.post(
    '/api/auth/logout',
    { preHandler: authGuard },
    async (request, reply) => {
      const auth = getAuthenticatedSession(request);
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
      const auth = getAuthenticatedSession(request);
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
