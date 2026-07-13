import type {
  Conflict,
  CurrentSession,
  Device,
  PullChangesResponse,
  PushOperationsResponse,
  ResolveConflictRequest,
  SyncOperation,
  TimerStateResponse,
} from '@kaoyan/contracts';

export interface TimedTimerResponse {
  data: TimerStateResponse;
  requestStartedAt: number;
  requestEndedAt: number;
}

export interface SyncApiClient {
  getCurrentSession(signal?: AbortSignal): Promise<CurrentSession>;
  pushOperations(
    operations: readonly SyncOperation[],
    signal?: AbortSignal,
  ): Promise<PushOperationsResponse>;
  pullChanges(
    cursor: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PullChangesResponse>;
  listConflicts(signal?: AbortSignal): Promise<readonly Conflict[]>;
  getConflict(conflictId: string, signal?: AbortSignal): Promise<Conflict>;
  getTimer(signal?: AbortSignal): Promise<TimedTimerResponse>;
}

export interface AccountApiClient extends SyncApiClient {
  login(
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<CurrentSession>;
  logout(signal?: AbortSignal): Promise<{ ok: true }>;
  changePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true }>;
  listDevices(signal?: AbortSignal): Promise<readonly Device[]>;
  renameDevice(
    deviceId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true }>;
  revokeDevice(deviceId: string, signal?: AbortSignal): Promise<{ ok: true }>;
  logoutOtherDevices(signal?: AbortSignal): Promise<{ ok: true }>;
  resolveConflict(
    conflictId: string,
    request: ResolveConflictRequest,
    signal?: AbortSignal,
  ): Promise<{
    conflict: Conflict;
    affectedVersions: Record<string, number>;
  }>;
}

export interface SyncLock {
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
}

export type SyncPhase =
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'offline'
  | 'authRequired'
  | 'error';

export interface SyncStatusSnapshot {
  phase: SyncPhase;
  pendingCount: number;
  rejectedCount: number;
  conflictCount: number;
  lastSuccessfulSyncAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}
