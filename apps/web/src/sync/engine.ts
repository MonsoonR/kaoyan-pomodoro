import type { SyncDatabase } from '../db/database';
import { applyPullPage } from './apply-changes';
import { applyPushReceipts } from './apply-receipts';
import { cacheConflicts } from './conflicts';
import {
  AuthRequiredError,
  NetworkError,
  ProtocolError,
  SyncClientError,
} from './errors';
import { createSyncLock } from './lock';
import { projectTimer } from './projector';
import { SyncStatusStore } from './status';
import type { SyncApiClient, SyncLock } from './types';

export interface SyncEngineDependencies {
  database: SyncDatabase;
  api: SyncApiClient;
  lock?: SyncLock;
  status?: SyncStatusStore;
  now?: () => Date;
}

export class SyncEngine {
  readonly status: SyncStatusStore;
  private readonly lock: SyncLock;
  private readonly now: () => Date;
  private running: Promise<void> | null = null;
  private rerunRequested = false;
  private authenticationPaused = false;
  private closed = false;
  private abortController: AbortController | null = null;

  constructor(private readonly dependencies: SyncEngineDependencies) {
    this.lock = dependencies.lock ?? createSyncLock();
    this.status = dependencies.status ?? new SyncStatusStore();
    this.now = dependencies.now ?? (() => new Date());
  }

  start(): Promise<void> {
    return this.requestSync();
  }

  manualSync(): Promise<void> {
    return this.requestSync();
  }

  requestAutomaticSync(): Promise<void> {
    return this.requestSync();
  }

  requestSync(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Sync engine is closed'));
    if (this.authenticationPaused) return Promise.resolve();
    if (this.running) {
      this.rerunRequested = true;
      return this.running;
    }
    this.running = this.runLoop().finally(() => { this.running = null; });
    return this.running;
  }

  resumeAfterAuthentication(): Promise<void> {
    this.authenticationPaused = false;
    return this.requestSync();
  }

  pauseForAuthentication(): void {
    this.authenticationPaused = true;
    this.rerunRequested = false;
  }

  markOffline(): void {
    if (this.status.getSnapshot().phase !== 'syncing')
      this.status.update({ phase: 'offline' });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rerunRequested = false;
    this.abortController?.abort();
    try { await this.running; } catch { /* status already captures the error */ }
    this.dependencies.database.close();
  }

  private async runLoop(): Promise<void> {
    do {
      this.rerunRequested = false;
      await this.lock.runExclusive(() => this.runCycle());
    } while (this.rerunRequested && !this.authenticationPaused && !this.closed);
  }

  private async runCycle(): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.status.update({
      phase: 'syncing', lastErrorCode: null, lastErrorMessage: null,
    });
    try {
      const session = await this.dependencies.api.getCurrentSession(signal);
      const userId = session.user.id;
      await this.dependencies.database.setActiveUser(userId);
      const metadata = await this.dependencies.database.getOrCreateMetadata(userId);
      await this.dependencies.database.metadata.put({
        ...metadata,
        activeUserId: userId,
        authState: 'authenticated',
        lastAttemptAt: this.now().toISOString(),
      });

      const conflicts = await this.push(userId, signal);
      for (const conflictId of conflicts) {
        try {
          const conflict = await this.dependencies.api.getConflict(
            conflictId,
            signal,
          );
          await cacheConflicts(
            this.dependencies.database,
            userId,
            [conflict],
            this.now().toISOString(),
          );
        } catch (error) {
          if (error instanceof AuthRequiredError) throw error;
        }
      }
      await this.pull(userId, signal);
      try {
        const listed = await this.dependencies.api.listConflicts(signal);
        await cacheConflicts(
          this.dependencies.database,
          userId,
          listed,
          this.now().toISOString(),
        );
      } catch (error) {
        if (error instanceof AuthRequiredError) throw error;
      }
      await this.refreshTimer(userId, signal);
      const completedAt = this.now().toISOString();
      const current = await this.dependencies.database.getOrCreateMetadata(userId);
      await this.dependencies.database.metadata.put({
        ...current,
        lastSuccessfulSyncAt: completedAt,
        authState: 'authenticated',
      });
      await this.updateCounts(userId, 'synced', completedAt);
    } catch (error) {
      await this.handleCycleError(error);
    } finally {
      this.abortController = null;
    }
  }

  private async push(userId: string, signal: AbortSignal): Promise<string[]> {
    const pending = (await this.dependencies.database.operations
      .where('userId')
      .equals(userId)
      .filter((row) => row.state === 'pending')
      .sortBy('sequence'))
      .slice(0, 100);
    pending.sort((left, right) =>
      (left.sequence ?? 0) - (right.sequence ?? 0));
    if (pending.length === 0) return [];
    const attemptedAt = this.now().toISOString();
    await this.dependencies.database.transaction(
      'rw',
      this.dependencies.database.operations,
      async () => {
        for (const row of pending) {
          if (row.sequence === undefined) throw new Error('Missing queue sequence');
          await this.dependencies.database.operations.update(row.sequence, {
            attempts: row.attempts + 1,
            lastAttemptAt: attemptedAt,
          });
        }
      },
    );
    const response = await this.dependencies.api.pushOperations(
      pending.map((row) => row.operation),
      signal,
    );
    return applyPushReceipts(
      this.dependencies.database,
      userId,
      pending,
      response,
      this.now().toISOString(),
    );
  }

  private async pull(userId: string, signal: AbortSignal): Promise<void> {
    while (true) {
      const metadata = await this.dependencies.database.getOrCreateMetadata(userId);
      const page = await this.dependencies.api.pullChanges(
        metadata.cursor,
        500,
        signal,
      );
      if (page.hasMore && page.changes.length === 0)
        throw new ProtocolError('Pull returned an empty page with hasMore');
      await applyPullPage(this.dependencies.database, userId, page);
      if (!page.hasMore) return;
    }
  }

  private async refreshTimer(userId: string, signal: AbortSignal): Promise<void> {
    const timed = await this.dependencies.api.getTimer(signal);
    const midpoint = (timed.requestStartedAt + timed.requestEndedAt) / 2;
    const clockOffsetMs = Date.parse(timed.data.serverTime) - midpoint;
    const clockUncertaintyMs =
      (timed.requestEndedAt - timed.requestStartedAt) / 2;
    const receivedAt = this.now().toISOString();
    const timerOperations = await this.dependencies.database.operations
      .where('userId')
      .equals(userId)
      .filter(
        (row) =>
          row.entityType === 'activeTimer' &&
          (row.state === 'pending' || row.state === 'acknowledged'),
      )
      .sortBy('sequence');
    const projectedTimer = projectTimer(timed.data.timer, timerOperations);
    await this.dependencies.database.transaction(
      'rw',
      [this.dependencies.database.timerCache, this.dependencies.database.metadata],
      async () => {
        await this.dependencies.database.timerCache.put({
          userId,
          serverTimer: timed.data.timer,
          projectedTimer,
          serverTime: timed.data.serverTime,
          receivedAt,
          clockOffsetMs,
          clockUncertaintyMs,
          pendingOperationIds: timerOperations.map((row) => row.operationId),
        });
        const metadata =
          await this.dependencies.database.getOrCreateMetadata(userId);
        await this.dependencies.database.metadata.put({
          ...metadata,
          clockOffsetMs,
          clockMeasuredAt: receivedAt,
          clockUncertaintyMs,
        });
      },
    );
  }

  private async updateCounts(
    userId: string,
    phase: 'synced' | 'error' | 'offline' | 'authRequired',
    lastSuccessfulSyncAt?: string,
  ): Promise<void> {
    const [pendingCount, rejectedCount, conflictCount] = await Promise.all([
      this.dependencies.database.countPendingOperations(userId),
      this.dependencies.database.operations
        .where('userId').equals(userId)
        .filter((row) => row.state === 'rejected').count(),
      this.dependencies.database.conflicts
        .where('[userId+status]').equals([userId, 'open']).count(),
    ]);
    this.status.update({
      phase,
      pendingCount,
      rejectedCount,
      conflictCount,
      ...(lastSuccessfulSyncAt === undefined ? {} : { lastSuccessfulSyncAt }),
    });
  }

  private async handleCycleError(error: unknown): Promise<void> {
    const activeUserId = await this.dependencies.database.getActiveUserId();
    if (error instanceof AuthRequiredError) {
      this.authenticationPaused = true;
      if (activeUserId) {
        const metadata =
          await this.dependencies.database.getOrCreateMetadata(activeUserId);
        await this.dependencies.database.metadata.put({
          ...metadata,
          authState: 'required',
        });
        await this.updateCounts(activeUserId, 'authRequired');
      } else this.status.update({ phase: 'authRequired' });
      this.status.update({
        lastErrorCode: error.code,
        lastErrorMessage: error.message,
      });
      return;
    }
    const clientError = error instanceof SyncClientError
      ? error
      : new SyncClientError('INTERNAL_ERROR', 'Synchronization failed');
    const phase = error instanceof NetworkError ? 'offline' : 'error';
    if (activeUserId) await this.updateCounts(activeUserId, phase);
    else this.status.update({ phase });
    this.status.update({
      lastErrorCode: clientError.code,
      lastErrorMessage: clientError.message,
    });
  }
}
