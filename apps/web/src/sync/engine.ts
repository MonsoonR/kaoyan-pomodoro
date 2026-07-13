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

const AUTHENTICATION_PAUSED_REASON = Object.freeze({
  code: 'AUTHENTICATION_PAUSED',
});
const CYCLE_INVALIDATED = Object.freeze({ code: 'SYNC_CYCLE_INVALIDATED' });

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
  private authenticationGeneration = 0;
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
    if (!this.authenticationPaused) this.authenticationGeneration += 1;
    this.authenticationPaused = true;
    this.rerunRequested = false;
    this.abortController?.abort(AUTHENTICATION_PAUSED_REASON);
  }

  markOffline(): void {
    if (this.status.getSnapshot().phase !== 'syncing')
      this.status.update({ phase: 'offline' });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rerunRequested = false;
    this.authenticationGeneration += 1;
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
    const generation = this.authenticationGeneration;
    if (this.isCycleInvalid(generation)) return;
    const abortController = new AbortController();
    this.abortController = abortController;
    const signal = abortController.signal;
    this.status.update({
      phase: 'syncing', lastErrorCode: null, lastErrorMessage: null,
    });
    try {
      const session = await this.dependencies.api.getCurrentSession(signal);
      this.assertCycleCurrent(generation);
      const userId = session.user.id;
      await this.dependencies.database.setActiveUser(userId);
      this.assertCycleCurrent(generation);
      const metadata = await this.dependencies.database.getOrCreateMetadata(userId);
      this.assertCycleCurrent(generation);
      await this.dependencies.database.metadata.put({
        ...metadata,
        activeUserId: userId,
        authState: 'authenticated',
        lastAttemptAt: this.now().toISOString(),
      });
      this.assertCycleCurrent(generation);

      const conflicts = await this.push(userId, signal, generation);
      for (const conflictId of conflicts) {
        this.assertCycleCurrent(generation);
        try {
          const conflict = await this.dependencies.api.getConflict(
            conflictId,
            signal,
          );
          this.assertCycleCurrent(generation);
          await cacheConflicts(
            this.dependencies.database,
            userId,
            [conflict],
            this.now().toISOString(),
          );
          this.assertCycleCurrent(generation);
        } catch (error) {
          this.assertCycleCurrent(generation);
          if (error instanceof AuthRequiredError) throw error;
        }
      }
      await this.pull(userId, signal, generation);
      this.assertCycleCurrent(generation);
      try {
        const listed = await this.dependencies.api.listConflicts(signal);
        this.assertCycleCurrent(generation);
        await cacheConflicts(
          this.dependencies.database,
          userId,
          listed,
          this.now().toISOString(),
        );
        this.assertCycleCurrent(generation);
      } catch (error) {
        this.assertCycleCurrent(generation);
        if (error instanceof AuthRequiredError) throw error;
      }
      await this.refreshTimer(userId, signal, generation);
      this.assertCycleCurrent(generation);
      const completedAt = this.now().toISOString();
      const current = await this.dependencies.database.getOrCreateMetadata(userId);
      this.assertCycleCurrent(generation);
      await this.dependencies.database.metadata.put({
        ...current,
        lastSuccessfulSyncAt: completedAt,
        authState: 'authenticated',
      });
      this.assertCycleCurrent(generation);
      await this.updateCounts(userId, 'synced', completedAt, generation);
    } catch (error) {
      if (error !== CYCLE_INVALIDATED && !this.isCycleInvalid(generation)) {
        try {
          await this.handleCycleError(error, generation);
        } catch (handlingError) {
          if (handlingError !== CYCLE_INVALIDATED &&
              !this.isCycleInvalid(generation))
            throw handlingError;
        }
      }
    } finally {
      if (this.abortController === abortController)
        this.abortController = null;
    }
  }

  private async push(
    userId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<string[]> {
    const pending = (await this.dependencies.database.operations
      .where('userId')
      .equals(userId)
      .filter((row) => row.state === 'pending')
      .sortBy('sequence'))
      .slice(0, 100);
    this.assertCycleCurrent(generation);
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
    this.assertCycleCurrent(generation);
    const response = await this.dependencies.api.pushOperations(
      pending.map((row) => row.operation),
      signal,
    );
    this.assertCycleCurrent(generation);
    const conflicts = await applyPushReceipts(
      this.dependencies.database,
      userId,
      pending,
      response,
      this.now().toISOString(),
    );
    this.assertCycleCurrent(generation);
    return conflicts;
  }

  private async pull(
    userId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    while (true) {
      this.assertCycleCurrent(generation);
      const metadata = await this.dependencies.database.getOrCreateMetadata(userId);
      this.assertCycleCurrent(generation);
      const page = await this.dependencies.api.pullChanges(
        metadata.cursor,
        500,
        signal,
      );
      this.assertCycleCurrent(generation);
      if (page.hasMore && page.changes.length === 0)
        throw new ProtocolError('Pull returned an empty page with hasMore');
      await applyPullPage(this.dependencies.database, userId, page);
      this.assertCycleCurrent(generation);
      if (!page.hasMore) return;
    }
  }

  private async refreshTimer(
    userId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    const timed = await this.dependencies.api.getTimer(signal);
    this.assertCycleCurrent(generation);
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
    this.assertCycleCurrent(generation);
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
    this.assertCycleCurrent(generation);
  }

  private async updateCounts(
    userId: string,
    phase: 'synced' | 'error' | 'offline' | 'authRequired',
    lastSuccessfulSyncAt?: string,
    generation?: number,
  ): Promise<void> {
    const [pendingCount, rejectedCount, conflictCount] = await Promise.all([
      this.dependencies.database.countPendingOperations(userId),
      this.dependencies.database.operations
        .where('userId').equals(userId)
        .filter((row) => row.state === 'rejected').count(),
      this.dependencies.database.conflicts
        .where('[userId+status]').equals([userId, 'open']).count(),
    ]);
    if (generation !== undefined) this.assertCycleCurrent(generation);
    this.status.update({
      phase,
      pendingCount,
      rejectedCount,
      conflictCount,
      ...(lastSuccessfulSyncAt === undefined ? {} : { lastSuccessfulSyncAt }),
    });
  }

  private async handleCycleError(
    error: unknown,
    generation: number,
  ): Promise<void> {
    if (error instanceof AuthRequiredError) {
      this.pauseForAuthentication();
      const activeUserId = await this.dependencies.database.getActiveUserId();
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
    this.assertCycleCurrent(generation);
    const activeUserId = await this.dependencies.database.getActiveUserId();
    this.assertCycleCurrent(generation);
    const clientError = error instanceof SyncClientError
      ? error
      : new SyncClientError('INTERNAL_ERROR', 'Synchronization failed');
    const phase = error instanceof NetworkError ? 'offline' : 'error';
    if (activeUserId)
      await this.updateCounts(activeUserId, phase, undefined, generation);
    else this.status.update({ phase });
    this.assertCycleCurrent(generation);
    this.status.update({
      lastErrorCode: clientError.code,
      lastErrorMessage: clientError.message,
    });
  }

  private isCycleInvalid(generation: number): boolean {
    return this.closed ||
      this.authenticationPaused ||
      generation !== this.authenticationGeneration;
  }

  private assertCycleCurrent(generation: number): void {
    if (this.isCycleInvalid(generation)) throw CYCLE_INVALIDATED;
  }
}
