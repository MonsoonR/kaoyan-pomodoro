// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { replicaKey } from '../../db/types';
import { TASK_ID, USER_A, task } from '../../test/fixtures';
import { useReplicaData } from './use-replica-data';

function Probe({ database }: { database: SyncDatabase }) {
  const result = useReplicaData(database, USER_A);
  if (!result.loaded) return <p>loading</p>;
  return <p>{result.tasks.map((value) => value.title).join(',')}</p>;
}

describe('live projected replica data', () => {
  let database: SyncDatabase | null = null;
  const storage = new Map<string, string>();
  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
  });
  afterEach(async () => {
    localStorage.clear();
    vi.unstubAllGlobals();
    if (database) await database.deleteDatabaseForTests();
  });

  it('ignores legacy localStorage and reacts to projectedValue changes', async () => {
    localStorage.setItem('kaoyan-pomodoro-state-v1', JSON.stringify({
      templates: [{ id: 'legacy', title: 'Legacy task' }],
      dailyTasks: [], sessions: [], settings: {},
    }));
    database = createSyncDatabase(`replica-hook-${crypto.randomUUID()}`);
    await database.open();
    const server = task({ title: 'Server title' });
    await database.replicas.put({
      key: replicaKey(USER_A, 'task', TASK_ID),
      userId: USER_A,
      entityType: 'task',
      entityId: TASK_ID,
      serverValue: server,
      projectedValue: { ...server, title: 'Optimistic title' },
      serverVersion: 1,
      pendingOperationIds: [],
      updatedLocallyAt: null,
    });

    render(<Probe database={database} />);
    expect(await screen.findByText('Optimistic title')).toBeTruthy();
    expect(screen.queryByText('Legacy task')).toBeNull();

    await database.replicas.update(replicaKey(USER_A, 'task', TASK_ID), {
      projectedValue: { ...server, title: 'Pulled title', version: 2 },
    });
    await waitFor(() => expect(screen.getByText('Pulled title')).toBeTruthy());
  });
});
