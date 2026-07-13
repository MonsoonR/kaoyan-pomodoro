// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { AppRuntime } from '../../runtime/app-runtime';
import { RuntimeProvider } from '../../runtime/runtime-context';
import { SyncStatusStore } from '../../sync/status';
import { session } from '../../test/fixtures';
import { SyncStatusPanel } from './SyncStatusPanel';

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
      ['syncing', '正在同步'], ['synced', '已同步'], ['offline', '离线使用'],
      ['authRequired', '需要重新登录'], ['error', '同步失败'],
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
    const button = screen.getByRole('button', { name: '立即同步' });
    await user.click(button);
    await user.click(button);
    expect(manualSync).toHaveBeenCalledTimes(1);
    finish();
    view.unmount();
    release();
    await runtime.closed();
  });
});
