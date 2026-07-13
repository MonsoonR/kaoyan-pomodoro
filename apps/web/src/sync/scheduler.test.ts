import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../db/database';
import { FakeApiClient } from '../test/fake-api';
import { SyncEngine } from './engine';
import { SyncScheduler } from './scheduler';

class FakeEvents {
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void): void {
    const values = this.listeners.get(type) ?? new Set();
    values.add(listener);
    this.listeners.set(type, values);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

describe('sync scheduler', () => {
  let database: SyncDatabase;
  let engine: SyncEngine;
  let windowValue: FakeEvents;
  let documentValue: FakeEvents & { visibilityState: DocumentVisibilityState };
  let interval: (() => void) | undefined;
  let intervalMs = 0;
  let enqueue: (() => void) | undefined;
  let scheduler: SyncScheduler;

  beforeEach(async () => {
    database = createSyncDatabase(`scheduler-${crypto.randomUUID()}`);
    await database.open();
    engine = new SyncEngine({ database, api: new FakeApiClient() });
    vi.spyOn(engine, 'start').mockResolvedValue();
    vi.spyOn(engine, 'requestAutomaticSync').mockResolvedValue();
    vi.spyOn(engine, 'manualSync').mockResolvedValue();
    windowValue = new FakeEvents();
    documentValue = Object.assign(new FakeEvents(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    scheduler = new SyncScheduler({
      engine,
      window: windowValue,
      document: documentValue,
      navigator: { onLine: true },
      timers: {
        setInterval: (callback, milliseconds) => {
          interval = callback; intervalMs = milliseconds; return 1;
        },
        clearInterval: vi.fn(),
      },
      subscribeToEnqueue: (listener) => {
        enqueue = listener;
        return () => { enqueue = undefined; };
      },
    });
  });
  afterEach(async () => database.deleteDatabaseForTests());

  it('syncs at startup and installs one set of listeners', () => {
    scheduler.start();
    scheduler.start();
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(windowValue.listeners.get('online')?.size).toBe(1);
    expect(documentValue.listeners.get('visibilitychange')?.size).toBe(1);
  });

  it('triggers on online, foreground, enqueue, manual, and 30 seconds', async () => {
    scheduler.start();
    windowValue.emit('online');
    documentValue.emit('visibilitychange');
    enqueue?.();
    interval?.();
    await scheduler.manualSync();
    expect(intervalMs).toBe(30_000);
    expect(engine.requestAutomaticSync).toHaveBeenCalledTimes(4);
    expect(engine.manualSync).toHaveBeenCalledTimes(1);
  });

  it('ignores visibility changes while hidden', () => {
    scheduler.start();
    documentValue.visibilityState = 'hidden';
    documentValue.emit('visibilitychange');
    expect(engine.requestAutomaticSync).not.toHaveBeenCalled();
  });

  it('skips periodic network requests while known offline', () => {
    scheduler = new SyncScheduler({
      engine,
      window: windowValue,
      document: documentValue,
      navigator: { onLine: false },
      timers: {
        setInterval: (callback) => { interval = callback; return 1; },
        clearInterval: vi.fn(),
      },
    });
    const offline = vi.spyOn(engine, 'markOffline');
    scheduler.start();
    interval?.();
    expect(offline).toHaveBeenCalled();
    expect(engine.requestAutomaticSync).not.toHaveBeenCalled();
  });

  it('removes listeners, interval, and enqueue subscription on stop', () => {
    scheduler.start();
    scheduler.stop();
    expect(windowValue.listeners.get('online')?.size).toBe(0);
    expect(documentValue.listeners.get('visibilitychange')?.size).toBe(0);
    expect(enqueue).toBeUndefined();
  });
});
