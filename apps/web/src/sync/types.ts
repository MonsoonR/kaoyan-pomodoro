import type {
  Conflict,
  CurrentSession,
  PullChangesResponse,
  PushOperationsResponse,
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
