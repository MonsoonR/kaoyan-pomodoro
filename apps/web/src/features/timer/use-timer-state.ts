import { liveQuery } from 'dexie';
import { useEffect, useMemo, useState } from 'react';
import type { SyncDatabase } from '../../db/database';
import type { OperationRow, SyncIssueRow, TimerCacheRow } from '../../db/types';
import {
  calibrationLabel,
  estimateServerNow,
  formatTimerClock,
  remainingTimerMilliseconds,
  type EstimatedServerClock,
} from './timer-clock';
import {
  buildTimerViewModel,
  type TimerViewModel,
} from './timer-view-model';

interface TimerSource {
  cache: TimerCacheRow | null;
  operations: OperationRow[];
  syncIssues: SyncIssueRow[];
}

export interface TimerStateSnapshot {
  loaded: boolean;
  viewModel: TimerViewModel;
  clock: EstimatedServerClock;
  clockLabel: string;
  remainingMs: number;
  clockText: string;
}

const EMPTY_SOURCE: TimerSource = {
  cache: null,
  operations: [],
  syncIssues: [],
};

export function useTimerState(
  database: SyncDatabase,
  userId: string | null,
): TimerStateSnapshot {
  const [source, setSource] = useState<TimerSource>(EMPTY_SOURCE);
  const [loaded, setLoaded] = useState(false);
  const [localNowMs, setLocalNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!userId) {
      setSource(EMPTY_SOURCE);
      setLoaded(true);
      return undefined;
    }
    setLoaded(false);
    let active = true;
    const subscription = liveQuery(async () => {
      const [cache, operations, syncIssues] = await Promise.all([
        database.timerCache.get(userId),
        database.operations
          .where('userId')
          .equals(userId)
          .filter((row) => row.entityType === 'activeTimer')
          .sortBy('sequence'),
        database.syncIssues.where('userId').equals(userId).toArray(),
      ]);
      return {
        cache: cache ?? null,
        operations,
        syncIssues: syncIssues.sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt)),
      };
    }).subscribe({
      next: (value) => {
        if (!active) return;
        setSource(value);
        setLoaded(true);
      },
      error: () => { if (active) setLoaded(true); },
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [database, userId]);

  useEffect(() => {
    const update = () => setLocalNowMs(Date.now());
    const interval = window.setInterval(update, 1_000);
    const visible = () => {
      if (document.visibilityState === 'visible') update();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  return useMemo(() => {
    const viewModel = buildTimerViewModel({
      serverTimer: source.cache?.serverTimer ?? null,
      operations: source.operations,
      syncIssues: source.syncIssues,
    });
    const provisional = viewModel.provisional;
    const clock = estimateServerNow({
      localNowMs,
      clockOffsetMs: provisional ? null : source.cache?.clockOffsetMs ?? null,
      clockMeasuredAt: provisional ? null : source.cache?.receivedAt ?? null,
      clockUncertaintyMs: provisional
        ? null
        : source.cache?.clockUncertaintyMs ?? null,
    });
    const remainingMs = viewModel.timer
      ? remainingTimerMilliseconds(viewModel.timer, clock)
      : 0;
    return {
      loaded,
      viewModel,
      clock,
      clockLabel: provisional ? '正在保存 · 时间为暂时显示' : calibrationLabel(clock),
      remainingMs,
      clockText: formatTimerClock(remainingMs),
    };
  }, [loaded, localNowMs, source]);
}
