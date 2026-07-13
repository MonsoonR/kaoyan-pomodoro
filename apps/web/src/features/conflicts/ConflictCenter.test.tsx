// @vitest-environment jsdom
import type {
  Conflict,
  ConflictResolution,
  ConflictType,
  ResolveConflictRequest,
} from '@kaoyan/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { conflictKey } from '../../db/types';
import { AppRuntime } from '../../runtime/app-runtime';
import { RuntimeProvider } from '../../runtime/runtime-context';
import { SyncClientError } from '../../sync/errors';
import { SyncStatusStore } from '../../sync/status';
import { NOW, session, TASK_ID, USER_A } from '../../test/fixtures';
import { ConflictCenter } from './ConflictCenter';

const CASES: Array<[ConflictType, ConflictResolution, string]> = [
  ['delete_modify', 'keepServer', '保留服务器修改'],
  ['delete_modify', 'applyDelete', '确认删除'],
  ['delete_modify', 'copyAsNew', '复制后删除原任务'],
  ['complete_restore', 'complete', '最终标记完成'],
  ['complete_restore', 'restore', '恢复为待完成'],
  ['archive_add_today', 'keepArchived', '保持归档'],
  ['archive_add_today', 'addAnyway', '归档但仍加入今日'],
  ['archive_add_today', 'unarchiveAndAdd', '取消归档并加入今日'],
];

function openConflict(type: ConflictType): Conflict {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    entityType: type === 'complete_restore' ? 'dailyTask' : 'task',
    entityId: TASK_ID,
    conflictType: type,
    localOperationId: 'b0000000-0000-4000-8000-000000000001',
    baseVersion: 1,
    serverVersion: 2,
    localPayload: { title: 'Local' },
    serverPayload: { title: 'Server' },
    createdAt: NOW,
    status: 'open',
    resolution: null,
    resolutionResult: null,
    resolvedAt: null,
  };
}

describe('conflict center', () => {
  const databases: SyncDatabase[] = [];
  afterEach(async () => {
    cleanup();
    for (const database of databases.splice(0))
      await database.deleteDatabaseForTests();
  });

  it.each(CASES)('submits and caches %s/%s then synchronizes', async (type, resolution, label) => {
    const conflict = openConflict(type);
    const resolveConflict = vi.fn(async (
      _id: string,
      request: ResolveConflictRequest,
    ) => ({
      conflict: {
        ...conflict,
        status: 'resolved' as const,
        resolution,
        resolutionResult: { resolutionRequest: request, affectedVersions: {} },
        resolvedAt: NOW,
      },
      affectedVersions: {},
    }));
    const database = createSyncDatabase(`conflict-ui-${crypto.randomUUID()}`);
    databases.push(database);
    const manualSync = vi.fn(async () => undefined);
    const runtime = new AppRuntime({
      database,
      api: {
        getCurrentSession: vi.fn(async () => session()),
        resolveConflict,
      } as never,
      engine: { status: new SyncStatusStore() } as never,
      scheduler: { start: vi.fn(), stop: vi.fn(), manualSync },
    });
    const release = runtime.acquire();
    await runtime.ready();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><ConflictCenter conflicts={[conflict]} /></RuntimeProvider>);
    await user.click(screen.getByRole('button', { name: '查看并解决' }));
    await user.click(screen.getByRole('radio', { name: new RegExp(`^${label}`) }));
    await user.click(screen.getByRole('button', { name: '确认解决' }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
    const request = resolveConflict.mock.calls[0]?.[1];
    if (resolution === 'copyAsNew') {
      expect(request).toMatchObject({ resolution: 'copyAsNew' });
      expect((request as { newEntityId: string }).newEntityId).toMatch(/^[0-9a-f-]{36}$/i);
    } else expect(request).toEqual({ resolution });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(manualSync).toHaveBeenCalledTimes(1);
    expect((await database.conflicts.get(conflictKey(USER_A, conflict.id)))?.status)
      .toBe('resolved');
    view.unmount();
    release();
    await runtime.closed();
  });

  it('keeps the dialog open and reports resolution failures', async () => {
    const conflict = openConflict('delete_modify');
    const database = createSyncDatabase(`conflict-failure-${crypto.randomUUID()}`);
    databases.push(database);
    const runtime = new AppRuntime({
      database,
      api: {
        getCurrentSession: vi.fn(async () => session()),
        resolveConflict: vi.fn(async () => {
          throw new SyncClientError('CONFLICT_ALREADY_RESOLVED', 'different');
        }),
      } as never,
      engine: { status: new SyncStatusStore() } as never,
      scheduler: { start: vi.fn(), stop: vi.fn(), manualSync: vi.fn() },
    });
    const release = runtime.acquire();
    await runtime.ready();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><ConflictCenter conflicts={[conflict]} /></RuntimeProvider>);
    await user.click(screen.getByRole('button', { name: '查看并解决' }));
    await user.click(screen.getByRole('radio', { name: /确认删除/ }));
    await user.click(screen.getByRole('button', { name: '确认解决' }));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('已在其他设备用不同方式解决');
    expect(screen.getByRole('dialog')).toBeTruthy();
    view.unmount();
    release();
    await runtime.closed();
  });
});
