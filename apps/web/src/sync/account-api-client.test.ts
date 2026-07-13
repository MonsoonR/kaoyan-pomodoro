import { describe, expect, it, vi } from 'vitest';
import { NOW, session } from '../test/fixtures';
import { createApiClient } from './api-client';

const success = { ok: true } as const;

describe('account API client', () => {
  it.each([
    ['login', ['/api/auth/login', 'POST', { username: 'learner', password: 'secure password' }]],
    ['logout', ['/api/auth/logout', 'POST', undefined]],
    ['changePassword', ['/api/auth/change-password', 'POST', {
      currentPassword: 'current password', newPassword: 'new password 123',
      confirmPassword: 'new password 123',
    }]],
    ['renameDevice', ['/api/devices/a0000000-0000-4000-8000-000000000001', 'PATCH', { name: 'Study laptop' }]],
    ['revokeDevice', ['/api/devices/a0000000-0000-4000-8000-000000000001', 'DELETE', undefined]],
    ['logoutOtherDevices', ['/api/devices/logout-others', 'POST', undefined]],
  ] as const)('sends %s with credentials and the exact body', async (method, [path, verb, body]) => {
    const response = method === 'login' ? session() : success;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const client = createApiClient({ fetch: fetchMock });
    const args = method === 'login'
        ? ['learner', 'secure password']
        : method === 'changePassword'
          ? ['current password', 'new password 123', 'new password 123']
          : method === 'renameDevice'
            ? ['a0000000-0000-4000-8000-000000000001', 'Study laptop']
            : method === 'revokeDevice'
              ? ['a0000000-0000-4000-8000-000000000001']
              : [];
    const callable = client as unknown as Record<
      string,
      (...values: string[]) => Promise<unknown>
    >;
    await callable[method]!(...args);
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({
      method: verb,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  });

  it('lists devices and resolves conflicts with validated responses', async () => {
    const conflictId = 'b0000000-0000-4000-8000-000000000001';
    const resolvedAt = NOW;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        conflict: {
          id: conflictId,
          entityType: 'task',
          entityId: 'c0000000-0000-4000-8000-000000000001',
          conflictType: 'delete_modify',
          localOperationId: 'd0000000-0000-4000-8000-000000000001',
          baseVersion: 1,
          serverVersion: 2,
          localPayload: {}, serverPayload: {}, createdAt: NOW,
          status: 'resolved', resolution: 'keepServer',
          resolutionResult: { resolutionRequest: { resolution: 'keepServer' }, affectedVersions: {} },
          resolvedAt,
        },
        affectedVersions: {},
      })));
    const client = createApiClient({ fetch: fetchMock });
    await expect(client.listDevices()).resolves.toEqual([]);
    await expect(client.resolveConflict(conflictId, { resolution: 'keepServer' }))
      .resolves.toMatchObject({ conflict: { status: 'resolved' } });
  });

  it('preserves a structured server error code and safe message', async () => {
    const client = createApiClient({ fetch: async () => new Response(JSON.stringify({
      code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect',
    }), { status: 401 }) });
    await expect(client.changePassword('wrong password', 'new password 123', 'new password 123'))
      .rejects.toMatchObject({
        code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is incorrect',
      });
  });
});
