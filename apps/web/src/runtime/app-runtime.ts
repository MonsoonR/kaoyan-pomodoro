import type { CurrentSession } from '@kaoyan/contracts';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { createApiClient } from '../sync/api-client';
import { SyncEngine } from '../sync/engine';
import { AuthRequiredError, NetworkError } from '../sync/errors';
import { OfflineOperationQueue } from '../sync/queue';
import { SyncScheduler } from '../sync/scheduler';
import type { AccountApiClient, SyncStatusSnapshot } from '../sync/types';

export type RuntimeAuthMode =
  | 'booting'
  | 'login'
  | 'authenticated'
  | 'offline'
  | 'authRequired';

export interface RuntimeSnapshot {
  authMode: RuntimeAuthMode;
  activeUserId: string | null;
  session: CurrentSession | null;
  username: string | null;
  firstLoginOffline: boolean;
}

interface StatusLike {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Partial<SyncStatusSnapshot>;
}

interface EngineLike {
  status: StatusLike;
  resumeAfterAuthentication?(): Promise<void>;
  manualSync?(): Promise<void>;
  close?(): Promise<void>;
}

interface SchedulerLike {
  start(): void;
  stop(): void;
  manualSync?(): Promise<void>;
}

export interface AppRuntimeDependencies {
  database: SyncDatabase;
  api: AccountApiClient;
  engine: EngineLike;
  scheduler: SchedulerLike;
}

type Listener = () => void;

export class AppRuntime {
  readonly database: SyncDatabase;
  readonly api: AccountApiClient;
  readonly engine: EngineLike;
  readonly scheduler: SchedulerLike;
  private readonly queues = new Map<string, OfflineOperationQueue>();
  private readonly queueSubscriptions = new Map<string, () => void>();
  private readonly listeners = new Set<Listener>();
  private readonly enqueueListeners = new Set<Listener>();
  private snapshot: RuntimeSnapshot = {
    authMode: 'booting',
    activeUserId: null,
    session: null,
    username: null,
    firstLoginOffline: false,
  };
  private leases = 0;
  private started = false;
  private disposed = false;
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private unsubscribeStatus: (() => void) | null = null;

  constructor(dependencies: AppRuntimeDependencies) {
    this.database = dependencies.database;
    this.api = dependencies.api;
    this.engine = dependencies.engine;
    this.scheduler = dependencies.scheduler;
  }

  acquire(): () => void {
    this.leases += 1;
    if (!this.started) {
      this.started = true;
      this.startPromise = this.start();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases -= 1;
      queueMicrotask(() => {
        if (this.leases === 0) this.disposePromise = this.dispose();
      });
    };
  }

  ready(): Promise<void> {
    return this.startPromise ?? Promise.resolve();
  }

  async closed(): Promise<void> {
    await Promise.resolve();
    await this.disposePromise;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): RuntimeSnapshot {
    return this.snapshot;
  }

  subscribeToEnqueue(listener: Listener): () => void {
    this.enqueueListeners.add(listener);
    return () => this.enqueueListeners.delete(listener);
  }

  queueFor(userId: string): OfflineOperationQueue {
    let queue = this.queues.get(userId);
    if (!queue) {
      queue = new OfflineOperationQueue(this.database, userId);
      this.queues.set(userId, queue);
      this.queueSubscriptions.set(userId, queue.subscribe(() => {
        for (const listener of this.enqueueListeners) listener();
      }));
    }
    return queue;
  }

  async login(username: string, password: string): Promise<CurrentSession> {
    const session = await this.api.login(username, password);
    await this.activateSession(session);
    await this.engine.resumeAfterAuthentication?.();
    return session;
  }

  async logout(): Promise<void> {
    await this.api.logout();
    await this.authenticationRequired();
  }

  async authenticationRequired(): Promise<void> {
    const userId = this.snapshot.activeUserId;
    if (userId) {
      const metadata = await this.database.getOrCreateMetadata(userId);
      await this.database.metadata.put({ ...metadata, authState: 'required' });
    }
    this.update({
      authMode: 'authRequired',
      session: null,
      firstLoginOffline: false,
    });
  }

  manualSync(): Promise<void> {
    return this.scheduler.manualSync?.() ??
      this.engine.manualSync?.() ??
      Promise.resolve();
  }

  private async start(): Promise<void> {
    await this.database.open();
    const activeUserId = await this.database.getActiveUserId();
    let username: string | null = null;
    if (activeUserId) {
      const metadata = await this.database.getOrCreateMetadata(activeUserId);
      username = metadata.username;
      this.update({ activeUserId, username });
      this.queueFor(activeUserId);
    }
    this.unsubscribeStatus = this.engine.status.subscribe(() => {
      const phase = this.engine.status.getSnapshot().phase;
      if (phase === 'authRequired') {
        this.update({
          authMode: this.snapshot.activeUserId ? 'authRequired' : 'login',
          firstLoginOffline: false,
        });
      } else if (phase === 'offline') {
        this.update({
          authMode: this.snapshot.activeUserId ? 'offline' : 'login',
          firstLoginOffline: !this.snapshot.activeUserId,
        });
      } else if (
        phase === 'synced' &&
        this.snapshot.session
      ) {
        this.update({ authMode: 'authenticated', firstLoginOffline: false });
      }
    });
    try {
      const session = await this.api.getCurrentSession();
      await this.activateSession(session);
    } catch (error) {
      if (error instanceof NetworkError) {
        this.update({
          authMode: activeUserId ? 'offline' : 'login',
          firstLoginOffline: !activeUserId,
        });
      } else if (error instanceof AuthRequiredError) {
        if (activeUserId) {
          const metadata = await this.database.getOrCreateMetadata(activeUserId);
          await this.database.metadata.put({ ...metadata, authState: 'required' });
        }
        this.update({
          authMode: activeUserId ? 'authRequired' : 'login',
          firstLoginOffline: false,
        });
      } else {
        this.update({
          authMode: activeUserId ? 'offline' : 'login',
          firstLoginOffline: !activeUserId,
        });
      }
    }
    if (!this.disposed) this.scheduler.start();
  }

  private async activateSession(session: CurrentSession): Promise<void> {
    await this.database.setActiveUser(session.user.id);
    const metadata = await this.database.getOrCreateMetadata(session.user.id);
    await this.database.metadata.put({
      ...metadata,
      activeUserId: session.user.id,
      authState: 'authenticated',
      username: session.user.username,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      sessionExpiresAt: session.expiresAt,
    });
    this.queueFor(session.user.id);
    this.update({
      authMode: 'authenticated',
      activeUserId: session.user.id,
      session,
      username: session.user.username,
      firstLoginOffline: false,
    });
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.stop();
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    for (const unsubscribe of this.queueSubscriptions.values()) unsubscribe();
    this.queueSubscriptions.clear();
    await this.startPromise?.catch(() => undefined);
    if (this.engine.close) await this.engine.close();
    else this.database.close();
  }
}

export function createBrowserRuntime(): AppRuntime {
  const database = createSyncDatabase();
  const api = createApiClient();
  const engine = new SyncEngine({ database, api });
  const holder: { current: AppRuntime | null } = { current: null };
  const scheduler = new SyncScheduler({
    engine,
    window,
    document,
    navigator,
    timers: window,
    subscribeToEnqueue: (listener) =>
      holder.current?.subscribeToEnqueue(listener) ?? (() => undefined),
  });
  const runtime = new AppRuntime({ database, api, engine, scheduler });
  holder.current = runtime;
  return runtime;
}
