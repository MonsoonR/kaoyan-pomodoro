// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '@kaoyan/contracts';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { RuntimeProvider } from '../../runtime/runtime-context';
import { AppRuntime } from '../../runtime/app-runtime';
import { SyncStatusStore } from '../../sync/status';
import { NOW, session } from '../../test/fixtures';
import { AccountPanel } from './AccountPanel';

describe('account and device settings', () => {
  let database: SyncDatabase | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    if (database) await database.deleteDatabaseForTests();
  });

  it('renames and revokes devices, logs out others, and refreshes after password change', async () => {
    const current = session();
    const otherId = 'a0000000-0000-4000-8000-000000000001';
    const devices: Device[] = [
      {
        id: current.deviceId, name: 'Current laptop', browser: 'Chrome',
        operatingSystem: 'Windows', isCurrent: true,
        firstLoginAt: NOW, lastActiveAt: NOW,
      },
      {
        id: otherId, name: 'Phone', browser: 'Safari',
        operatingSystem: 'iOS', isCurrent: false,
        firstLoginAt: NOW, lastActiveAt: NOW,
      },
    ];
    const api = {
      getCurrentSession: vi.fn(async () => current),
      listDevices: vi.fn(async () => devices),
      renameDevice: vi.fn(async () => ({ ok: true as const })),
      revokeDevice: vi.fn(async () => ({ ok: true as const })),
      logoutOtherDevices: vi.fn(async () => ({ ok: true as const })),
      changePassword: vi.fn(async () => ({ ok: true as const })),
      logout: vi.fn(async () => ({ ok: true as const })),
    };
    database = createSyncDatabase(`devices-ui-${crypto.randomUUID()}`);
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine: { status: new SyncStatusStore() } as never,
      scheduler: { start: vi.fn(), stop: vi.fn() },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><AccountPanel /></RuntimeProvider>);

    expect(await screen.findByText(/Phone/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /退出设备.*Current laptop/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: '重命名：Phone' }));
    const name = screen.getByLabelText('设备名称');
    await user.clear(name);
    await user.type(name, 'Study phone');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(api.renameDevice).toHaveBeenCalledWith(otherId, 'Study phone'));

    await user.click(screen.getByRole('button', { name: '退出设备' }));
    await waitFor(() => expect(api.revokeDevice).toHaveBeenCalledWith(otherId));
    await user.click(screen.getByRole('button', { name: '退出其他所有设备' }));
    await waitFor(() => expect(api.logoutOtherDevices).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText('当前密码'), 'current password');
    await user.type(screen.getByLabelText('新密码'), 'new password 123');
    await user.type(screen.getByLabelText('确认新密码'), 'new password 123');
    await user.click(screen.getByRole('button', { name: '修改密码' }));
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith(
      'current password', 'new password 123', 'new password 123',
    ));
    expect(api.listDevices.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect((screen.getByLabelText('当前密码') as HTMLInputElement).value).toBe('');
    view.unmount();
    await runtime.closed();
  });
});
