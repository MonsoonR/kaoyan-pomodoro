import type { SyncStatusSnapshot } from './types';

type StatusListener = () => void;

const INITIAL_STATUS: SyncStatusSnapshot = {
  phase: 'idle',
  pendingCount: 0,
  rejectedCount: 0,
  conflictCount: 0,
  lastSuccessfulSyncAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
};

export class SyncStatusStore {
  private snapshot: SyncStatusSnapshot = INITIAL_STATUS;
  private readonly listeners = new Set<StatusListener>();

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SyncStatusSnapshot {
    return this.snapshot;
  }

  update(patch: Partial<SyncStatusSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
