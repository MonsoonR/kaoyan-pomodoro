import type { SyncEntityType } from '@kaoyan/contracts';
import type {
  OperationRow,
  ServerEntity,
} from '../db/types';

export type VersionPredictionOperation = Pick<
  OperationRow,
  'operation' | 'state' | 'receipt'
>;

interface PredictionState {
  version: number;
  exists: boolean;
  deleted: boolean;
  archived: boolean;
  dailyStatus: string | null;
  timerFinalized: boolean;
}

function initialState(
  serverVersion: number,
  serverValue: ServerEntity | null,
  entityType: SyncEntityType | undefined,
): PredictionState {
  return {
    version: serverVersion,
    exists: serverValue !== null,
    deleted: serverValue === null && serverVersion > 0,
    archived:
      entityType === 'task' && serverValue !== null &&
      'archived' in serverValue
        ? serverValue.archived
        : false,
    dailyStatus:
      entityType === 'dailyTask' && serverValue !== null &&
      'pomodoroCompleted' in serverValue
        ? serverValue.status
        : null,
    timerFinalized:
      entityType === 'activeTimer' &&
      serverValue === null &&
      serverVersion > 0,
  };
}

function applyPredictedOperation(
  state: PredictionState,
  row: VersionPredictionOperation,
): void {
  const operation = row.operation;
  if (operation.entityType === 'focusSession')
    throw new Error('Focus sessions cannot participate in version prediction');

  if (operation.entityType === 'task') {
    if (operation.operationType === 'create') {
      state.version = 1;
      state.exists = true;
      state.deleted = false;
      state.archived = false;
    } else if (operation.operationType === 'update') {
      state.version += 1;
    } else if (operation.operationType === 'archive') {
      if (!state.archived) state.version += 1;
      state.archived = true;
    } else if (operation.operationType === 'unarchive') {
      if (state.archived) state.version += 1;
      state.archived = false;
    } else if (state.exists && !state.deleted) {
      state.version += 1;
      state.exists = false;
      state.deleted = true;
    }
  } else if (operation.entityType === 'dailyTask') {
    if (
      operation.operationType === 'create' ||
      operation.operationType === 'addToToday'
    ) {
      state.version = 1;
      state.exists = true;
      state.deleted = false;
      state.dailyStatus = 'pending';
    } else if (operation.operationType === 'update') {
      state.version += 1;
    } else if (operation.operationType === 'complete') {
      if (state.dailyStatus !== 'completed') state.version += 1;
      state.dailyStatus = 'completed';
    } else if (operation.operationType === 'restore') {
      if (state.dailyStatus !== 'pending') state.version += 1;
      state.dailyStatus = 'pending';
    } else if (state.exists && !state.deleted) {
      state.version += 1;
      state.exists = false;
      state.deleted = true;
    }
  } else if (operation.entityType === 'settings') {
    state.version += 1;
  } else if (operation.operationType === 'timerStart') {
    state.version = 1;
    state.exists = true;
    state.deleted = false;
    state.timerFinalized = false;
  } else if (
    operation.operationType === 'timerPause' ||
    operation.operationType === 'timerResume'
  ) {
    state.version += 1;
  } else if (!state.timerFinalized) {
    state.version += 1;
    state.exists = false;
    state.deleted = true;
    state.timerFinalized = true;
  }

  if (row.state === 'acknowledged') {
    const receiptVersion = row.receipt?.entityVersion;
    if (receiptVersion !== null && receiptVersion !== undefined)
      state.version = receiptVersion;
  }
}

export function predictServerVersion(
  serverVersion: number,
  serverValue: ServerEntity | null,
  orderedOperations: readonly VersionPredictionOperation[],
): number {
  const active = orderedOperations.filter(
    (row) => row.state === 'pending' || row.state === 'acknowledged',
  );
  const state = initialState(
    serverVersion,
    serverValue,
    active[0]?.operation.entityType,
  );
  for (const row of active) applyPredictedOperation(state, row);
  return state.version;
}
