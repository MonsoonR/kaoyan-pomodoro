import type {
  ActiveTimer,
  Conflict,
  DailyTask,
  FocusSession,
  OperationReceipt,
  Settings,
  SyncEntityType,
  SyncOperation,
  Task,
} from '@kaoyan/contracts';

export type ServerEntity =
  | Task
  | DailyTask
  | Settings
  | FocusSession
  | ActiveTimer;

export type LocalTask = Omit<Task, 'version'> & { version: number };
export type LocalDailyTask = Omit<DailyTask, 'version'> & { version: number };
export type LocalSettings = Omit<Settings, 'version'> & { version: number };

export interface LocalTimerProjection {
  id: string;
  dailyTaskId: string;
  phase: 'focus' | 'short_break' | 'long_break';
  plannedSeconds: number;
  startedAt: string;
  targetEndAt: string;
  pausedAt: string | null;
  status:
    | 'starting'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'resuming'
    | 'completing'
    | 'exiting';
  version: number;
  reason: string | null;
}

export type ProjectedEntity =
  | ServerEntity
  | LocalTask
  | LocalDailyTask
  | LocalSettings
  | LocalTimerProjection;

export interface ReplicaRow {
  key: string;
  userId: string;
  entityType: SyncEntityType;
  entityId: string;
  serverValue: ServerEntity | null;
  projectedValue: ProjectedEntity | null;
  serverVersion: number;
  pendingOperationIds: string[];
  updatedLocallyAt: string | null;
}

export type OperationState =
  | 'pending'
  | 'acknowledged'
  | 'rejected'
  | 'conflict';

export interface OperationRow {
  sequence?: number;
  operationId: string;
  userId: string;
  operation: SyncOperation;
  entityType: SyncEntityType;
  entityId: string;
  state: OperationState;
  attempts: number;
  enqueuedAt: string;
  lastAttemptAt: string | null;
  receipt: OperationReceipt | null;
  lastError: { code: string; message: string } | null;
  conflictId: string | null;
  projectionSeed: ProjectedEntity | null;
}

export type AuthenticationState = 'unknown' | 'authenticated' | 'required';

export interface MetadataRow {
  userId: string;
  cursor: number;
  activeUserId: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptAt: string | null;
  authState: AuthenticationState;
  latestKnownServerCursor: number;
  clockOffsetMs: number | null;
  clockMeasuredAt: string | null;
  clockUncertaintyMs: number | null;
  pendingCount: number;
  username: string | null;
  deviceId: string | null;
  deviceName: string | null;
  sessionExpiresAt: string | null;
}

export interface ConflictRow {
  key: string;
  id: string;
  userId: string;
  status: Conflict['status'];
  conflictType: Conflict['conflictType'];
  entityType: Conflict['entityType'];
  entityId: string;
  value: Conflict;
  fetchedAt: string;
}

export interface TimerCacheRow {
  userId: string;
  serverTimer: ActiveTimer | null;
  projectedTimer: ActiveTimer | LocalTimerProjection | null;
  serverTime: string | null;
  receivedAt: string | null;
  clockOffsetMs: number | null;
  clockUncertaintyMs: number | null;
  pendingOperationIds: string[];
}

export interface SyncIssueRow {
  id?: number;
  operationId: string;
  userId: string;
  errorCode: string;
  errorMessage: string;
  operation: SyncOperation;
  createdAt: string;
}

export function replicaKey(
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
): string {
  return `${userId}:${entityType}:${entityId}`;
}

export function conflictKey(userId: string, conflictId: string): string {
  return `${userId}:${conflictId}`;
}

export function isActiveTimer(
  value: ServerEntity | ProjectedEntity | null,
): value is ActiveTimer {
  return value !== null &&
    'targetEndAt' in value &&
    'accumulatedPausedSeconds' in value &&
    'status' in value;
}

export function isTimerProjection(
  value: ProjectedEntity | null,
): value is ActiveTimer | LocalTimerProjection {
  return value !== null &&
    'plannedSeconds' in value &&
    'dailyTaskId' in value &&
    'status' in value &&
    [
      'running',
      'paused',
      'starting',
      'pausing',
      'resuming',
      'completing',
      'exiting',
    ]
      .includes(value.status);
}
