import type { SyncEngine } from './engine';

interface WindowLike {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
}
interface DocumentLike {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
interface NavigatorLike { onLine: boolean }
interface TimerLike {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(id: unknown): void;
}

export interface SchedulerDependencies {
  engine: SyncEngine;
  window: WindowLike;
  document: DocumentLike;
  navigator: NavigatorLike;
  timers: TimerLike;
  subscribeToEnqueue?: (listener: () => void) => () => void;
}

export class SyncScheduler {
  private intervalId: unknown = null;
  private unsubscribeEnqueue: (() => void) | null = null;
  private started = false;

  constructor(private readonly dependencies: SchedulerDependencies) {}

  private readonly online = (): void => {
    void this.dependencies.engine.requestAutomaticSync();
  };
  private readonly foreground = (): void => {
    if (this.dependencies.document.visibilityState === 'visible')
      void this.dependencies.engine.requestAutomaticSync();
  };
  private readonly enqueued = (): void => {
    void this.dependencies.engine.requestAutomaticSync();
  };
  private readonly interval = (): void => {
    if (!this.dependencies.navigator.onLine) {
      this.dependencies.engine.markOffline();
      return;
    }
    void this.dependencies.engine.requestAutomaticSync();
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.dependencies.window.addEventListener('online', this.online);
    this.dependencies.document.addEventListener(
      'visibilitychange',
      this.foreground,
    );
    this.unsubscribeEnqueue =
      this.dependencies.subscribeToEnqueue?.(this.enqueued) ?? null;
    this.intervalId = this.dependencies.timers.setInterval(
      this.interval,
      30_000,
    );
    void this.dependencies.engine.start();
  }

  manualSync(): Promise<void> {
    return this.dependencies.engine.manualSync();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.dependencies.window.removeEventListener('online', this.online);
    this.dependencies.document.removeEventListener(
      'visibilitychange',
      this.foreground,
    );
    if (this.intervalId !== null)
      this.dependencies.timers.clearInterval(this.intervalId);
    this.intervalId = null;
    this.unsubscribeEnqueue?.();
    this.unsubscribeEnqueue = null;
  }
}
