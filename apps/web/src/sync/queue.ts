import {
  SyncOperationSchema,
  type SyncOperation,
} from '@kaoyan/contracts';
import type { SyncDatabase } from '../db/database';
import type {
  LocalDailyTask,
  OperationRow,
  ProjectedEntity,
  ReplicaRow,
} from '../db/types';
import {
  isActiveTimer,
  isTimerProjection,
  replicaKey,
} from '../db/types';
import { projectEntity, projectTimer } from './projector';
import { predictServerVersion } from './version-predictor';

type OperationDraft = Omit<SyncOperation, 'operationId' | 'createdAt'>;
type EnqueueListener = () => void;

export interface QueueDependencies {
  now?: () => Date;
  randomUUID?: () => string;
  beforeReplicaWrite?: () => void | Promise<void>;
}

export class OfflineOperationQueue {
  private readonly listeners = new Set<EnqueueListener>();
  private readonly completionEnqueues = new Map<string, Promise<OperationRow>>();
  private startEnqueue: Promise<OperationRow> | null = null;
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(
    private readonly database: SyncDatabase,
    readonly userId: string,
    private readonly dependencies: QueueDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomUUID =
      dependencies.randomUUID ?? (() => crypto.randomUUID());
  }

  subscribe(listener: EnqueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async baseVersion(
    entityType: SyncOperation['entityType'],
    entityId: string,
  ): Promise<number> {
    return this.database.transaction(
      'r',
      [
        this.database.replicas,
        this.database.operations,
        this.database.timerCache,
      ],
      async () => {
        const replica = await this.database.replicas.get(
          replicaKey(this.userId, entityType, entityId),
        );
        const timerCache = entityType === 'activeTimer'
          ? await this.database.timerCache.get(this.userId)
          : null;
        const operations = await this.database.operations
          .where('[userId+entityType+entityId]')
          .equals([this.userId, entityType, entityId])
          .filter(
            (row) =>
              row.state === 'pending' ||
              row.state === 'acknowledged',
          )
          .sortBy('sequence');
        return predictServerVersion(
          timerCache?.serverTimer?.id === entityId
            ? timerCache.serverTimer.version
            : replica?.serverVersion ?? 0,
          timerCache?.serverTimer?.id === entityId
            ? timerCache.serverTimer
            : replica?.serverValue ?? null,
          operations,
        );
      },
    );
  }

  async enqueueOperation(
    draft: OperationDraft,
    projectionSeed: ProjectedEntity | null = null,
  ): Promise<OperationRow> {
    if (draft.entityType === 'focusSession')
      throw new Error('The client cannot enqueue focus session creation');
    const createdAt = this.now().toISOString();
    const operation = SyncOperationSchema.parse({
      ...draft,
      operationId: this.randomUUID(),
      createdAt,
    });
    const row = await this.database.transaction(
      'rw',
      [
        this.database.operations,
        this.database.replicas,
        this.database.metadata,
        this.database.timerCache,
      ],
      async () => {
        const stored: OperationRow = {
          operationId: operation.operationId,
          userId: this.userId,
          operation,
          entityType: operation.entityType,
          entityId: operation.entityId,
          state: 'pending',
          attempts: 0,
          enqueuedAt: createdAt,
          lastAttemptAt: null,
          receipt: null,
          lastError: null,
          conflictId: null,
          projectionSeed,
        };
        const sequence = await this.database.operations.add(stored);
        stored.sequence = sequence;
        await this.dependencies.beforeReplicaWrite?.();
        const key = replicaKey(
          this.userId,
          operation.entityType,
          operation.entityId,
        );
        const existing = await this.database.replicas.get(key);
        const timerCache = operation.entityType === 'activeTimer'
          ? await this.database.timerCache.get(this.userId)
          : null;
        const active = await this.database.operations
          .where('[userId+entityType+entityId]')
          .equals([this.userId, operation.entityType, operation.entityId])
          .filter(
            (candidate) =>
              candidate.state === 'pending' ||
              candidate.state === 'acknowledged',
          )
          .sortBy('sequence');
        const serverValue = existing?.serverValue ?? null;
        const projectedValue =
          operation.entityType === 'activeTimer'
            ? projectTimer(
                isActiveTimer(serverValue)
                  ? serverValue
                  : timerCache?.serverTimer ?? null,
                active,
              )
            : projectEntity(existing?.serverValue ?? null, active);
        const replica: ReplicaRow = {
          key,
          userId: this.userId,
          entityType: operation.entityType,
          entityId: operation.entityId,
          serverValue: existing?.serverValue ?? null,
          projectedValue,
          serverVersion: existing?.serverVersion ?? 0,
          pendingOperationIds: active.map((candidate) => candidate.operationId),
          updatedLocallyAt: createdAt,
        };
        await this.database.replicas.put(replica);
        const metadata = await this.database.getOrCreateMetadata(this.userId);
        const pendingCount =
          await this.database.countPendingOperations(this.userId);
        await this.database.metadata.put({ ...metadata, pendingCount });
        if (operation.entityType === 'activeTimer') {
          await this.database.timerCache.put({
            userId: this.userId,
            serverTimer: timerCache?.serverTimer ?? null,
            projectedTimer: isTimerProjection(projectedValue)
              ? projectedValue
              : null,
            serverTime: timerCache?.serverTime ?? null,
            receivedAt: timerCache?.receivedAt ?? null,
            clockOffsetMs: timerCache?.clockOffsetMs ?? null,
            clockUncertaintyMs: timerCache?.clockUncertaintyMs ?? null,
            pendingOperationIds: active.map(
              (candidate) => candidate.operationId,
            ),
          });
        }
        return stored;
      },
    );
    this.emit();
    return row;
  }

  async createTask(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'task'; operationType: 'create';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'task', operationType: 'create', entityId,
      baseVersion: 0, payload,
    });
  }

  async updateTask(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'task'; operationType: 'update';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'task', operationType: 'update', entityId,
      baseVersion: await this.baseVersion('task', entityId), payload,
    });
  }

  async deleteTask(entityId: string): Promise<OperationRow> {
    return this.taskStateOperation(entityId, 'delete');
  }

  async archiveTask(entityId: string): Promise<OperationRow> {
    return this.taskStateOperation(entityId, 'archive');
  }

  async unarchiveTask(entityId: string): Promise<OperationRow> {
    return this.taskStateOperation(entityId, 'unarchive');
  }

  private async taskStateOperation(
    entityId: string,
    operationType: 'delete' | 'archive' | 'unarchive',
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'task', operationType, entityId,
      baseVersion: await this.baseVersion('task', entityId), payload: {},
    });
  }

  async createDailyTask(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'dailyTask'; operationType: 'create';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'dailyTask', operationType: 'create', entityId,
      baseVersion: 0, payload,
    });
  }

  async addToToday(
    entityId: string,
    payload: Omit<Extract<SyncOperation, {
      entityType: 'dailyTask'; operationType: 'addToToday';
    }>['payload'], 'sourceTaskVersion'>,
  ): Promise<OperationRow> {
    const source = await this.database.replicas.get(
      replicaKey(this.userId, 'task', payload.sourceTaskId),
    );
    const task = source?.projectedValue;
    if (!task || !('defaultPomodoroTarget' in task))
      throw new Error('Source task is not available in the local replica');
    const now = this.now().toISOString();
    const seed: LocalDailyTask = {
      id: entityId,
      sourceTaskId: payload.sourceTaskId,
      date: payload.date,
      title: task.title,
      subject: task.subject,
      pomodoroTarget: task.defaultPomodoroTarget,
      pomodoroCompleted: 0,
      timerPreset: task.defaultTimerPreset,
      status: 'pending',
      sortOrder: payload.sortOrder,
      completedAt: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const sourceTaskVersion = await this.baseVersion(
      'task',
      payload.sourceTaskId,
    );
    return this.enqueueOperation({
      entityType: 'dailyTask', operationType: 'addToToday', entityId,
      baseVersion: 0, payload: { ...payload, sourceTaskVersion },
    }, seed);
  }

  async updateDailyTask(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'dailyTask'; operationType: 'update';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'dailyTask', operationType: 'update', entityId,
      baseVersion: await this.baseVersion('dailyTask', entityId), payload,
    });
  }

  async deleteDailyTask(entityId: string): Promise<OperationRow> {
    return this.dailyStateOperation(entityId, 'delete');
  }

  async completeDailyTask(entityId: string): Promise<OperationRow> {
    return this.dailyStateOperation(entityId, 'complete');
  }

  async restoreDailyTask(entityId: string): Promise<OperationRow> {
    return this.dailyStateOperation(entityId, 'restore');
  }

  private async dailyStateOperation(
    entityId: string,
    operationType: 'delete' | 'complete' | 'restore',
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'dailyTask', operationType, entityId,
      baseVersion: await this.baseVersion('dailyTask', entityId), payload: {},
    });
  }

  async updateSettings(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'settings'; operationType: 'update';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'settings', operationType: 'update', entityId,
      baseVersion: await this.baseVersion('settings', entityId), payload,
    });
  }

  async startTimer(
    entityId: string,
    payload: Extract<SyncOperation, {
      entityType: 'activeTimer'; operationType: 'timerStart';
    }>['payload'],
  ): Promise<OperationRow> {
    return this.enqueueOperation({
      entityType: 'activeTimer', operationType: 'timerStart', entityId,
      baseVersion: 0, payload,
    });
  }

  async startTimerForDailyTask(
    timerId: string,
    dailyTaskId: string,
    phase: 'focus' | 'short_break' | 'long_break',
    plannedSeconds: number,
  ): Promise<OperationRow> {
    if (this.startEnqueue) return this.startEnqueue;
    const promise = (async () => {
      const cache = await this.database.timerCache.get(this.userId);
      if (cache?.projectedTimer || cache?.serverTimer)
        throw new Error('A local timer is already active');
      const activeTimerOperation = await this.database.operations
        .where('userId')
        .equals(this.userId)
        .filter((row) => row.entityType === 'activeTimer' &&
          (row.state === 'pending' || row.state === 'acknowledged'))
        .first();
      if (activeTimerOperation)
        throw new Error('A local timer operation is already active');
      const dailyTaskVersion = await this.baseVersion('dailyTask', dailyTaskId);
      if (dailyTaskVersion < 1)
        throw new Error('Daily task is not available in the local replica');
      return this.startTimer(timerId, {
        dailyTaskId,
        dailyTaskVersion,
        phase,
        plannedSeconds,
      });
    })();
    this.startEnqueue = promise;
    const clear = () => {
      if (this.startEnqueue === promise) this.startEnqueue = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async pauseTimer(entityId: string, reason: string): Promise<OperationRow> {
    return this.timerStateOperation(entityId, 'timerPause', { reason });
  }

  async resumeTimer(entityId: string): Promise<OperationRow> {
    return this.timerStateOperation(entityId, 'timerResume', {});
  }

  async completeTimer(entityId: string): Promise<OperationRow> {
    return this.timerStateOperation(entityId, 'timerComplete', {});
  }

  completeTimerOnce(entityId: string): Promise<OperationRow> {
    const inFlight = this.completionEnqueues.get(entityId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const existing = await this.database.operations
        .where('[userId+entityType+entityId]')
        .equals([this.userId, 'activeTimer', entityId])
        .filter((row) =>
          (row.state === 'pending' || row.state === 'acknowledged') &&
          row.operation.operationType === 'timerComplete')
        .first();
      return existing ?? this.completeTimer(entityId);
    })();
    this.completionEnqueues.set(entityId, promise);
    const clear = () => {
      if (this.completionEnqueues.get(entityId) === promise)
        this.completionEnqueues.delete(entityId);
    };
    void promise.then(clear, clear);
    return promise;
  }

  async exitTimer(entityId: string, reason: string): Promise<OperationRow> {
    return this.timerStateOperation(entityId, 'timerExit', { reason });
  }

  async acknowledgeTimerIssue(operationId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [this.database.operations, this.database.syncIssues],
      async () => {
        const row = await this.database.operations
          .where('operationId')
          .equals(operationId)
          .first();
        if (!row || row.userId !== this.userId || row.state !== 'rejected' ||
            row.entityType !== 'activeTimer' || row.sequence === undefined)
          throw new Error('Rejected timer operation is not available');
        await this.database.operations.delete(row.sequence);
        await this.database.syncIssues
          .where('operationId')
          .equals(operationId)
          .delete();
      },
    );
  }

  async retryTimerOperation(operationId: string): Promise<OperationRow> {
    const original = await this.database.operations
      .where('operationId')
      .equals(operationId)
      .first();
    if (!original || original.userId !== this.userId ||
        original.state !== 'rejected' || original.entityType !== 'activeTimer')
      throw new Error('Rejected timer operation is not available');
    const operation = original.operation;
    if (operation.entityType !== 'activeTimer')
      throw new Error('Rejected operation is not a timer operation');
    const timer = (await this.database.timerCache.get(this.userId))?.serverTimer ?? null;
    if (operation.operationType === 'timerStart') {
      if (timer) throw new Error('A server timer is already active');
      return this.startTimerForDailyTask(
        operation.entityId,
        operation.payload.dailyTaskId,
        operation.payload.phase,
        operation.payload.plannedSeconds,
      );
    }
    if (!timer || timer.id !== operation.entityId)
      throw new Error('The timer has already ended on another device');
    if (operation.operationType === 'timerPause') {
      if (timer.status !== 'running')
        throw new Error('The server timer cannot be paused now');
      return this.pauseTimer(operation.entityId, operation.payload.reason);
    }
    if (operation.operationType === 'timerResume') {
      if (timer.status !== 'paused')
        throw new Error('The server timer cannot be resumed now');
      return this.resumeTimer(operation.entityId);
    }
    if (operation.operationType === 'timerComplete') {
      if (timer.status !== 'running')
        throw new Error('The server timer cannot be completed now');
      return this.completeTimer(operation.entityId);
    }
    return this.exitTimer(operation.entityId, operation.payload.reason);
  }

  private async timerStateOperation(
    entityId: string,
    operationType:
      | 'timerPause'
      | 'timerResume'
      | 'timerComplete'
      | 'timerExit',
    payload: { reason: string } | Record<string, never>,
  ): Promise<OperationRow> {
    const baseVersion = await this.baseVersion('activeTimer', entityId);
    if (operationType === 'timerPause')
      return this.enqueueOperation({
        entityType: 'activeTimer', operationType, entityId, baseVersion,
        payload: payload as { reason: string },
      });
    if (operationType === 'timerExit')
      return this.enqueueOperation({
        entityType: 'activeTimer', operationType, entityId, baseVersion,
        payload: payload as { reason: string },
      });
    return this.enqueueOperation({
      entityType: 'activeTimer', operationType, entityId, baseVersion,
      payload: {},
    });
  }
}
