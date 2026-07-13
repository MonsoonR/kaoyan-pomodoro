import type {
  ActiveTimer,
  DailyTask,
  Settings,
  SyncOperation,
  Task,
} from '@kaoyan/contracts';
import type {
  LocalDailyTask,
  LocalSettings,
  LocalTask,
  LocalTimerProjection,
  OperationRow,
  ProjectedEntity,
} from '../db/types';

type ProjectableOperation = SyncOperation | OperationRow;

function isRow(value: ProjectableOperation): value is OperationRow {
  return 'operation' in value;
}

function operationOf(value: ProjectableOperation): SyncOperation {
  return isRow(value) ? value.operation : value;
}

function isActive(value: ProjectableOperation): boolean {
  return !isRow(value) ||
    value.state === 'pending' ||
    value.state === 'acknowledged';
}

function seedOf(value: ProjectableOperation): ProjectedEntity | null {
  return isRow(value) ? value.projectionSeed : null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function changedPatch<T extends object>(
  current: T,
  patch: object,
): { value: T; changed: boolean } {
  let changed = false;
  const value = { ...current } as T;
  const target = value as Record<string, unknown>;
  const source = patch as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!Object.is(target[key], source[key])) {
      target[key] = source[key];
      changed = true;
    }
  }
  return { value, changed };
}

function bump<T extends { version: number; updatedAt: string }>(
  value: T,
  createdAt: string,
): T {
  return { ...value, version: value.version + 1, updatedAt: createdAt };
}

function createLocalTask(operation: Extract<SyncOperation, {
  entityType: 'task';
  operationType: 'create';
}>): LocalTask {
  return {
    id: operation.entityId,
    ...operation.payload,
    notes: operation.payload.notes ?? null,
    archived: false,
    version: 0,
    createdAt: operation.createdAt,
    updatedAt: operation.createdAt,
    deletedAt: null,
  };
}

function createLocalDailyTask(operation: Extract<SyncOperation, {
  entityType: 'dailyTask';
  operationType: 'create';
}>): LocalDailyTask {
  return {
    id: operation.entityId,
    ...operation.payload,
    pomodoroCompleted: 0,
    status: 'pending',
    completedAt: null,
    version: 0,
    createdAt: operation.createdAt,
    updatedAt: operation.createdAt,
    deletedAt: null,
  };
}

export function projectEntity(
  serverValue: ProjectedEntity | null,
  orderedOperations: readonly ProjectableOperation[],
): ProjectedEntity | null {
  let current: ProjectedEntity | null = clone(serverValue);
  const operations = orderedOperations.filter(isActive);

  for (const item of operations) {
    const operation = operationOf(item);
    if (operation.entityType === 'focusSession')
      throw new Error('Focus sessions cannot be projected from local operations');
    if (operation.entityType === 'activeTimer')
      throw new Error('Use projectTimer for active timer operations');

    if (operation.entityType === 'task') {
      if (operation.operationType === 'create') {
        current = createLocalTask(operation);
        continue;
      }
      if (operation.operationType === 'delete') {
        current = null;
        continue;
      }
      if (!current) throw new Error('Task mutation has no projection base');
      const task = current as Task | LocalTask;
      if (operation.operationType === 'update') {
        const result = changedPatch(task, operation.payload);
        current = result.changed
          ? bump(result.value, operation.createdAt)
          : result.value;
        continue;
      }
      const archived = operation.operationType === 'archive';
      current = task.archived === archived
        ? task
        : bump({ ...task, archived }, operation.createdAt);
      continue;
    }

    if (operation.entityType === 'dailyTask') {
      if (operation.operationType === 'create') {
        current = createLocalDailyTask(operation);
        continue;
      }
      if (operation.operationType === 'addToToday') {
        const seed = seedOf(item);
        if (!seed) throw new Error('addToToday requires a local projection seed');
        current = clone(seed);
        continue;
      }
      if (operation.operationType === 'delete') {
        current = null;
        continue;
      }
      if (!current) throw new Error('Daily task mutation has no projection base');
      const daily = current as DailyTask | LocalDailyTask;
      if (operation.operationType === 'update') {
        const result = changedPatch(daily, operation.payload);
        current = result.changed
          ? bump(result.value, operation.createdAt)
          : result.value;
        continue;
      }
      const completed = operation.operationType === 'complete';
      const desiredStatus: DailyTask['status'] =
        completed ? 'completed' : 'pending';
      const desiredCompletedAt = completed ? operation.createdAt : null;
      if (daily.status === desiredStatus) {
        current = daily;
      } else {
        current = bump(
          {
            ...daily,
            status: desiredStatus,
            completedAt: desiredCompletedAt,
          },
          operation.createdAt,
        );
      }
      continue;
    }

    if (!current) throw new Error('Settings update has no projection base');
    const settings = current as Settings | LocalSettings;
    const result = changedPatch(settings, operation.payload);
    current = result.changed
      ? bump(result.value, operation.createdAt)
      : result.value;
  }
  return current === null ? null : clone(current);
}

export function projectTimer(
  serverTimer: ActiveTimer | null,
  orderedOperations: readonly ProjectableOperation[],
): ActiveTimer | LocalTimerProjection | null {
  let current: ActiveTimer | LocalTimerProjection | null = clone(serverTimer);
  for (const item of orderedOperations.filter(isActive)) {
    const operation = operationOf(item);
    if (operation.entityType !== 'activeTimer') continue;
    if (operation.operationType === 'timerStart') {
      current = {
        id: operation.entityId,
        dailyTaskId: operation.payload.dailyTaskId,
        phase: operation.payload.phase,
        plannedSeconds: operation.payload.plannedSeconds,
        status: 'starting',
        version: 0,
        reason: null,
      };
    } else if (
      operation.operationType === 'timerComplete' ||
      operation.operationType === 'timerExit'
    ) {
      current = null;
    } else {
      if (!current) throw new Error('Timer mutation has no projection base');
      const reason =
        operation.operationType === 'timerPause'
          ? operation.payload.reason
          : null;
      const status: LocalTimerProjection['status'] =
        operation.operationType === 'timerPause' ? 'pausing' : 'resuming';
      current = {
        id: current.id,
        dailyTaskId: current.dailyTaskId,
        phase: current.phase,
        plannedSeconds: current.plannedSeconds,
        status,
        version: current.version + 1,
        reason,
      };
    }
  }
  return current === null ? null : clone(current);
}
