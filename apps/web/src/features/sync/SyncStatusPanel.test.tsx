// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { AppRuntime } from '../../runtime/app-runtime';
import { RuntimeProvider } from '../../runtime/runtime-context';
import { SyncStatusStore } from '../../sync/status';
import { session } from '../../test/fixtures';
import { MobileSyncNotice, SyncStatusPanel } from './SyncStatusPanel';

describe('synchronization status UI', () => {
  let database: SyncDatabase | null = null;
  afterEach(async () => {
    cleanup();
    if (database) await database.deleteDatabaseForTests();
  });

  it('renders all phases, uses durable counts, and de-duplicates manual sync', async () => {
    const status = new SyncStatusStore();
    let finish: () => void = () => undefined;
    const manualSync = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    database = createSyncDatabase(`sync-status-${crypto.randomUUID()}`);
    const runtime = new AppRuntime({
      database,
      api: { getCurrentSession: vi.fn(async () => session()) } as never,
      engine: { status } as never,
      scheduler: { start: vi.fn(), stop: vi.fn(), manualSync },
    });
    const release = runtime.acquire();
    await runtime.ready();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><SyncStatusPanel
      pendingCount={3} rejectedCount={2} conflictCount={4} syncIssues={[]}
    /></RuntimeProvider>);
    for (const [phase, label] of [
      ['syncing', '正在同步'], ['synced', '已同步'], ['offline', '暂时无法同步'],
      ['authRequired', '需要重新登录'], ['error', '暂时无法同步'],
    ] as const) {
      status.update({ phase });
      await waitFor(() => expect(screen.getByText(label)).toBeTruthy());
    }
    status.update({ phase: 'synced', pendingCount: 99, rejectedCount: 99, conflictCount: 99 });
    await waitFor(() => expect(screen.getByText('已同步')).toBeTruthy());
    await user.click(screen.getByText('已同步'));
    const counts = document.querySelector('.sync-counts');
    expect(counts).toBeTruthy();
    expect(within(counts as HTMLElement).getByText('3')).toBeTruthy();
    expect(within(counts as HTMLElement).getByText('2')).toBeTruthy();
    expect(within(counts as HTMLElement).getByText('4')).toBeTruthy();
    const button = screen.getByRole('button', { name: '立即更新' });
    await user.click(button);
    await user.click(button);
    expect(manualSync).toHaveBeenCalledTimes(1);
    finish();
    view.unmount();
    release();
    await runtime.closed();
  });

  it('hides normal mobile states and shows only actionable compact notices', async () => {
    const status = new SyncStatusStore();
    const manualSync = vi.fn(async () => undefined);
    const onViewIssues = vi.fn();
    database = createSyncDatabase(`mobile-sync-notice-${crypto.randomUUID()}`);
    const runtime = new AppRuntime({
      database,
      api: { getCurrentSession: vi.fn(async () => session()) } as never,
      engine: { status } as never,
      scheduler: { start: vi.fn(), stop: vi.fn(), manualSync },
    });
    const release = runtime.acquire();
    await runtime.ready();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><MobileSyncNotice
      rejectedCount={0} conflictCount={0} onViewIssues={onViewIssues}
    /></RuntimeProvider>);

    for (const phase of ['idle', 'syncing', 'synced'] as const) {
      status.update({ phase });
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    }

    status.update({ phase: 'offline' });
    await waitFor(() => expect(screen.getByText('网络不可用')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(manualSync).toHaveBeenCalledTimes(1);

    status.update({ phase: 'synced' });
    view.rerender(<RuntimeProvider runtime={runtime}><MobileSyncNotice
      rejectedCount={0} conflictCount={2} onViewIssues={onViewIssues}
    /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByText('有记录需要确认')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: '查看' }));
    expect(onViewIssues).toHaveBeenCalledTimes(1);

    view.rerender(<RuntimeProvider runtime={runtime}><MobileSyncNotice
      rejectedCount={1} conflictCount={0} onViewIssues={onViewIssues}
    /></RuntimeProvider>);
    await waitFor(() => expect(screen.getByText('同步暂时失败')).toBeTruthy());

    view.unmount();
    release();
    await runtime.closed();
  });
});
