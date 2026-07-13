import type { SyncLock } from './types';

export class InProcessMutex implements SyncLock {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = (): void => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }
}

export class WebLocksSyncLock implements SyncLock {
  constructor(
    private readonly locks: LockManager,
    private readonly fallback: SyncLock = new InProcessMutex(),
  ) {}

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (!this.locks) return this.fallback.runExclusive(work);
    return this.locks.request('kaoyan-pomodoro-sync', work);
  }
}

const processSyncMutex = new InProcessMutex();

export function createSyncLock(
  navigatorValue: Navigator | undefined =
    typeof navigator === 'undefined' ? undefined : navigator,
): SyncLock {
  return navigatorValue?.locks
    ? new WebLocksSyncLock(navigatorValue.locks)
    : processSyncMutex;
}
