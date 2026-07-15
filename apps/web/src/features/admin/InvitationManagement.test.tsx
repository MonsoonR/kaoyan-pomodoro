// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { AppRuntime } from '../../runtime/app-runtime';
import { RuntimeProvider } from '../../runtime/runtime-context';
import { SyncStatusStore } from '../../sync/status';
import { InvitationManagement } from './InvitationManagement';

describe('invitation management', () => {
  const databases: SyncDatabase[] = [];
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    for (const database of databases.splice(0))
      await database.deleteDatabaseForTests();
  });

  it('creates, displays once, copies, and revokes an invitation', async () => {
    const database = createSyncDatabase(`invite-ui-${crypto.randomUUID()}`);
    databases.push(database);
    const invitation = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'active' as const,
      createdAt: '2026-07-15T08:00:00.000Z',
      expiresAt: '2026-07-16T08:00:00.000Z',
      usedAt: null,
      usedBy: null,
      revokedAt: null,
    };
    const inviteUrl = `https://example.test/#/invite/${'A'.repeat(43)}`;
    const api = {
      listInvitations: vi.fn(async () => [invitation]),
      createInvitation: vi.fn(async () => ({ invitation, inviteUrl })),
      revokeInvitation: vi.fn(async () => ({
        ...invitation,
        status: 'revoked' as const,
        revokedAt: '2026-07-15T09:00:00.000Z',
      })),
    };
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine: { status: new SyncStatusStore() } as never,
      scheduler: { start: vi.fn(), stop: vi.fn() },
    });
    const copy = vi.fn(async () => undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(<RuntimeProvider runtime={runtime}><InvitationManagement /></RuntimeProvider>);
    expect(await screen.findByText('可使用')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '创建邀请链接' }));
    expect(await screen.findByRole('dialog', { name: '邀请链接已创建' })).toBeTruthy();
    expect(screen.getByLabelText('邀请链接')).toHaveProperty('value', inviteUrl);
    await user.click(screen.getByRole('button', { name: '复制链接' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith(inviteUrl));
    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith(invitation.id));
    view.unmount();
    await runtime.closed();
  });
});
