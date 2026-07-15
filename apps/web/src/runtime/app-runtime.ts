import { CurrentSessionSchema, type CurrentSession } from '@kaoyan/contracts';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import type { MetadataRow } from '../db/types';
import { createApiClient } from '../sync/api-client';
import { SyncEngine } from '../sync/engine';
import { AuthRequiredError } from '../sync/errors';
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
  pauseForAuthentication?(): void;
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
  private authenticationGeneration = 0;
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private sessionRecoveryPromise: Promise<void> | null = null;
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
    const generation = this.invalidateAuthenticationWork();
    const session = await this.api.login(username, password);
    const activated = await this.activateSession(session, generation);
    if (activated) await this.engine.resumeAfterAuthentication?.();
    return session;
  }

  async registerWithInvite(
    token: string,
    username: string,
    password: string,
    confirmPassword: string,
  ): Promise<CurrentSession> {
    const generation = this.invalidateAuthenticationWork();
    const session = await this.api.registerWithInvite(
      token,
      username,
      password,
      confirmPassword,
    );
    const activated = await this.activateSession(session, generation);
    if (activated) await this.engine.resumeAfterAuthentication?.();
    return session;
  }

  async logout(): Promise<void> {
    this.invalidateAuthenticationWork();
    await this.api.logout();
    await this.authenticationRequired();
  }

  async changePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<void> {
    await this.api.changePassword(
      currentPassword,
      newPassword,
      confirmPassword,
    );
    const session = await this.api.getCurrentSession();
    await this.activateSession(session);
  }

  async authenticationRequired(): Promise<void> {
    this.invalidateAuthenticationWork();
    this.engine.pauseForAuthentication?.();
    this.update({
      authMode: 'authRequired',
      session: null,
      firstLoginOffline: false,
    });
    const userId = this.snapshot.activeUserId;
    if (userId) {
      const metadata = await this.database.getOrCreateMetadata(userId);
      await this.database.metadata.put({ ...metadata, authState: 'required' });
    }
  }

  manualSync(): Promise<void> {
    return this.scheduler.manualSync?.() ??
      this.engine.manualSync?.() ??
      Promise.resolve();
  }

  private async start(): Promise<void> {
    await this.database.open();
    const activeUserId = await this.database.getActiveUserId();
    let metadata: MetadataRow | null = null;
    if (activeUserId) {
      metadata = await this.database.getOrCreateMetadata(activeUserId);
      this.update({
        activeUserId,
        username: metadata.username,
        session: restoreSessionSummary(metadata),
      });
      this.queueFor(activeUserId);
      if (metadata.authState === 'required') {
        this.engine.pauseForAuthentication?.();
        this.update({
          authMode: 'authRequired',
          session: null,
          firstLoginOffline: false,
        });
      }
    }
    this.unsubscribeStatus = this.engine.status.subscribe(() => {
      const phase = this.engine.status.getSnapshot().phase;
      if (phase === 'authRequired') {
        this.invalidateAuthenticationWork();
        this.engine.pauseForAuthentication?.();
        this.update({
          authMode: this.snapshot.activeUserId ? 'authRequired' : 'login',
          session: null,
          firstLoginOffline: false,
        });
      } else if (phase === 'offline') {
        if (this.snapshot.authMode === 'authRequired') return;
        this.update({
          authMode: this.snapshot.activeUserId ? 'offline' : 'login',
          firstLoginOffline: !this.snapshot.activeUserId,
        });
      } else if (phase === 'synced') this.recoverSessionAfterSync();
    });
    if (metadata?.authState !== 'required') {
      try {
        const session = await this.api.getCurrentSession();
        await this.activateSession(session);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          if (activeUserId) await this.authenticationRequired();
          else this.update({
            authMode: 'login', session: null, firstLoginOffline: false,
          });
        } else {
          this.update({
            authMode: activeUserId ? 'offline' : 'login',
            firstLoginOffline: !activeUserId,
          });
        }
      }
    }
    if (!this.disposed) this.scheduler.start();
  }

  private recoverSessionAfterSync(): void {
    if (
      this.sessionRecoveryPromise ||
      this.disposed ||
      !this.snapshot.activeUserId ||
      this.snapshot.authMode === 'authRequired'
    ) return;
    const generation = this.authenticationGeneration;
    const activeUserId = this.snapshot.activeUserId;
    this.sessionRecoveryPromise = (async () => {
      try {
        const session = await this.api.getCurrentSession();
        if (!this.isAuthenticationWorkCurrent(generation, activeUserId) ||
            this.snapshot.authMode === 'authRequired') return;
        await this.activateSession(session, generation);
      } catch (error) {
        if (!this.isAuthenticationWorkCurrent(generation, activeUserId)) return;
        if (error instanceof AuthRequiredError) {
          await this.authenticationRequired();
        } else if (this.snapshot.authMode !== 'authRequired') {
          this.update({
            authMode: this.snapshot.activeUserId ? 'offline' : 'login',
            firstLoginOffline: !this.snapshot.activeUserId,
          });
        }
      }
    })().finally(() => { this.sessionRecoveryPromise = null; });
  }

  private async activateSession(
    session: CurrentSession,
    generation = this.authenticationGeneration,
  ): Promise<boolean> {
    if (!this.isAuthenticationWorkCurrent(generation)) return false;
    await this.database.setActiveUser(session.user.id);
    if (!this.isAuthenticationWorkCurrent(generation)) return false;
    const metadata = await this.database.getOrCreateMetadata(session.user.id);
    if (!this.isAuthenticationWorkCurrent(generation)) return false;
    await this.database.metadata.put({
      ...metadata,
      activeUserId: session.user.id,
      authState: 'authenticated',
      username: session.user.username,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      sessionExpiresAt: session.expiresAt,
      role: session.user.role,
      mustChangePassword: session.user.mustChangePassword,
    });
    if (!this.isAuthenticationWorkCurrent(generation)) return false;
    this.invalidateAuthenticationWork();
    this.queueFor(session.user.id);
    this.update({
      authMode: 'authenticated',
      activeUserId: session.user.id,
      session,
      username: session.user.username,
      firstLoginOffline: false,
    });
    return true;
  }

  private update(patch: Partial<RuntimeSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.invalidateAuthenticationWork();
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

  private invalidateAuthenticationWork(): number {
    this.authenticationGeneration += 1;
    return this.authenticationGeneration;
  }

  private isAuthenticationWorkCurrent(
    generation: number,
    activeUserId?: string,
  ): boolean {
    return !this.disposed &&
      generation === this.authenticationGeneration &&
      (activeUserId === undefined ||
        activeUserId === this.snapshot.activeUserId);
  }
}

function restoreSessionSummary(metadata: MetadataRow): CurrentSession | null {
  if (metadata.authState !== 'authenticated') return null;
  const parsed = CurrentSessionSchema.safeParse({
    user: {
      id: metadata.userId,
      username: metadata.username,
      role: metadata.role ?? 'user',
      mustChangePassword: metadata.mustChangePassword ?? false,
    },
    deviceId: metadata.deviceId,
    deviceName: metadata.deviceName,
    expiresAt: metadata.sessionExpiresAt,
  });
  return parsed.success ? parsed.data : null;
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
