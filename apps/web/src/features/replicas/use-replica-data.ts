import type {
  Conflict,
  DailyTask,
  FocusSession,
  Settings,
  Task,
} from '@kaoyan/contracts';
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import type { SyncDatabase } from '../../db/database';
import type {
  LocalDailyTask,
  LocalSettings,
  LocalTask,
  SyncIssueRow,
} from '../../db/types';

export interface ReplicaData {
  loaded: boolean;
  tasks: Array<Task | LocalTask>;
  dailyTasks: Array<DailyTask | LocalDailyTask>;
  settings: Settings | LocalSettings | null;
  focusSessions: FocusSession[];
  conflicts: Conflict[];
  pendingCount: number;
  rejectedCount: number;
  openConflictCount: number;
  syncIssues: SyncIssueRow[];
}

const EMPTY: ReplicaData = {
  loaded: false,
  tasks: [],
  dailyTasks: [],
  settings: null,
  focusSessions: [],
  conflicts: [],
  pendingCount: 0,
  rejectedCount: 0,
  openConflictCount: 0,
  syncIssues: [],
};

function byCreatedAt(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  return left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id);
}

async function readReplicaData(
  database: SyncDatabase,
  userId: string,
): Promise<ReplicaData> {
  const [rows, conflictRows, operations, syncIssues] = await Promise.all([
    database.replicas.where('userId').equals(userId).toArray(),
    database.conflicts.where('userId').equals(userId).toArray(),
    database.operations.where('userId').equals(userId).toArray(),
    database.syncIssues.where('userId').equals(userId).toArray(),
  ]);
  const visible = rows.filter((row) => row.projectedValue !== null);
  const tasks = visible
    .filter((row) => row.entityType === 'task')
    .map((row) => row.projectedValue as Task | LocalTask)
    .filter((value) => value.deletedAt === null)
    .sort(byCreatedAt);
  const dailyTasks = visible
    .filter((row) => row.entityType === 'dailyTask')
    .map((row) => row.projectedValue as DailyTask | LocalDailyTask)
    .filter((value) => value.deletedAt === null)
    .sort((left, right) =>
      left.date.localeCompare(right.date) ||
      left.sortOrder - right.sortOrder ||
      left.id.localeCompare(right.id));
  const settings = visible
    .find((row) => row.entityType === 'settings')
    ?.projectedValue as Settings | LocalSettings | undefined;
  const focusSessions = visible
    .filter((row) => row.entityType === 'focusSession')
    .map((row) => row.projectedValue as FocusSession)
    .filter((value) => value.deletedAt === null)
    .sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt) ||
      left.id.localeCompare(right.id));
  const conflicts = conflictRows
    .map((row) => row.value)
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      left.id.localeCompare(right.id));
  return {
    loaded: true,
    tasks,
    dailyTasks,
    settings: settings ?? null,
    focusSessions,
    conflicts,
    pendingCount: operations.filter((row) => row.state === 'pending').length,
    rejectedCount: operations.filter((row) => row.state === 'rejected').length,
    openConflictCount: conflicts.filter((value) => value.status === 'open').length,
    syncIssues: syncIssues.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)),
  };
}

export function useReplicaData(
  database: SyncDatabase,
  userId: string | null,
): ReplicaData {
  const [state, setState] = useState<ReplicaData>(EMPTY);
  useEffect(() => {
    if (!userId) {
      setState(EMPTY);
      return undefined;
    }
    let active = true;
    const subscription = liveQuery(() => readReplicaData(database, userId))
      .subscribe({
        next: (value) => { if (active) setState(value); },
        error: () => { if (active) setState((value) => ({ ...value, loaded: true })); },
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [database, userId]);
  return state;
}
