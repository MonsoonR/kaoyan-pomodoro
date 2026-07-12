import {
  DeviceIdParamsSchema,
  DeviceListResponseSchema,
  RenameDeviceRequestSchema,
  SuccessResponseSchema,
} from '@kaoyan/contracts';
import type { FastifyInstance } from 'fastify';

import type { Services } from '../auth/session-service';
import { getAuthenticatedSession, requireAuthentication } from '../auth/auth-hook';

interface DeviceListRow {
  id: string;
  name: string;
  browser: string;
  operating_system: string;
  first_login_at: number;
  last_active_at: number;
}

export async function deviceRoutes(app: FastifyInstance, services: Services) {
  const authGuard = requireAuthentication(services);

  app.get('/api/devices', { preHandler: authGuard }, async (request) => {
    const auth = getAuthenticatedSession(request);
    const now = services.now().getTime();
    const rows = services.sqlite
      .prepare(
        `
      SELECT
        devices.id,
        devices.name,
        devices.browser,
        devices.operating_system,
        MIN(sessions.created_at) AS first_login_at,
        MAX(sessions.last_seen_at) AS last_active_at
      FROM devices
      INNER JOIN sessions ON sessions.device_id = devices.id
      WHERE devices.user_id = ?
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > ?
      GROUP BY devices.id
      ORDER BY last_active_at DESC
    `,
      )
      .all(auth.user_id, now) as DeviceListRow[];

    return DeviceListResponseSchema.parse({
      devices: rows.map((row) => ({
        id: row.id,
        name: row.name,
        browser: row.browser,
        operatingSystem: row.operating_system,
        isCurrent: row.id === auth.device_id,
        firstLoginAt: new Date(row.first_login_at).toISOString(),
        lastActiveAt: new Date(row.last_active_at).toISOString(),
      })),
    });
  });

  app.patch(
    '/api/devices/:deviceId',
    { preHandler: authGuard },
    async (request, reply) => {
      const auth = getAuthenticatedSession(request);
      const { deviceId } = DeviceIdParamsSchema.parse(request.params);
      const body = RenameDeviceRequestSchema.parse(request.body);
      const result = services.sqlite
        .prepare(
          `
      UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?
    `,
        )
        .run(body.name, services.now().getTime(), deviceId, auth.user_id);
      if (!result.changes) {
        return reply
          .code(404)
          .send({ code: 'DEVICE_NOT_FOUND', message: 'Device not found' });
      }
      return SuccessResponseSchema.parse({ ok: true });
    },
  );

  app.delete(
    '/api/devices/:deviceId',
    { preHandler: authGuard },
    async (request, reply) => {
      const auth = getAuthenticatedSession(request);
      const { deviceId } = DeviceIdParamsSchema.parse(request.params);
      if (deviceId === auth.device_id) {
        return reply.code(409).send({
          code: 'CURRENT_DEVICE',
          message: 'Use logout for the current device',
        });
      }
      services.sqlite.transaction(() => {
        services.sqlite
          .prepare(
            `
        UPDATE sessions
        SET revoked_at = ?
        WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL
      `,
          )
          .run(services.now().getTime(), deviceId, auth.user_id);
      })();
      return SuccessResponseSchema.parse({ ok: true });
    },
  );

  app.post(
    '/api/devices/logout-others',
    { preHandler: authGuard },
    async (request) => {
      const auth = getAuthenticatedSession(request);
      services.sqlite
        .prepare(
          `
      UPDATE sessions
      SET revoked_at = ?
      WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
    `,
        )
        .run(services.now().getTime(), auth.user_id, auth.session_id);
      return SuccessResponseSchema.parse({ ok: true });
    },
  );
}
