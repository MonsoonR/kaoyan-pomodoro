import type { ActiveTimer } from '@kaoyan/contracts';
import { describe, expect, it } from 'vitest';
import { activeTimer } from '../../test/fixtures';
import {
  MAX_CLOCK_CALIBRATION_AGE_MS,
  MAX_CLOCK_UNCERTAINTY_MS,
  estimateServerNow,
  formatTimerClock,
  remainingTimerMilliseconds,
  shouldAutoCompleteTimer,
} from './timer-clock';

describe('timer server clock', () => {
  const localNowMs = Date.parse('2026-07-13T04:10:00.000Z');

  it.each([
    [2_000, localNowMs + 2_000],
    [-3_000, localNowMs - 3_000],
  ])('applies a signed offset of %i ms', (clockOffsetMs, expected) => {
    expect(estimateServerNow({
      localNowMs,
      clockOffsetMs,
      clockMeasuredAt: new Date(localNowMs - 1_000).toISOString(),
      clockUncertaintyMs: 120,
    })).toMatchObject({
      nowMs: expected,
      uncertaintyMs: 120,
      calibration: 'calibrated',
      reliable: true,
    });
  });

  it('marks missing, stale and high-uncertainty calibration explicitly', () => {
    expect(estimateServerNow({
      localNowMs,
      clockOffsetMs: null,
      clockMeasuredAt: null,
      clockUncertaintyMs: null,
    })).toMatchObject({
      nowMs: localNowMs,
      calibration: 'missing',
      reliable: false,
    });
    expect(estimateServerNow({
      localNowMs,
      clockOffsetMs: 50,
      clockMeasuredAt: new Date(
        localNowMs - MAX_CLOCK_CALIBRATION_AGE_MS - 1,
      ).toISOString(),
      clockUncertaintyMs: 10,
    }).calibration).toBe('stale');
    expect(estimateServerNow({
      localNowMs,
      clockOffsetMs: 50,
      clockMeasuredAt: new Date(localNowMs).toISOString(),
      clockUncertaintyMs: MAX_CLOCK_UNCERTAINTY_MS + 1,
    }).calibration).toBe('uncertain');
  });

  it('recomputes a running timer from injected wall time after sleep', () => {
    const timer = activeTimer({
      targetEndAt: '2026-07-13T04:25:00.000Z',
    });
    const clock = estimateServerNow({
      localNowMs,
      clockOffsetMs: 2_000,
      clockMeasuredAt: new Date(localNowMs).toISOString(),
      clockUncertaintyMs: 100,
    });
    expect(remainingTimerMilliseconds(timer, clock)).toBe(898_000);
    expect(remainingTimerMilliseconds(timer, {
      ...clock,
      nowMs: clock.nowMs + 8 * 60_000,
    })).toBe(418_000);
  });

  it('freezes a paused timer independently of local wall time', () => {
    const timer: ActiveTimer = {
      ...activeTimer(),
      status: 'paused',
      pausedAt: '2026-07-13T04:08:00.000Z',
    };
    const clock = estimateServerNow({
      localNowMs,
      clockOffsetMs: -4_000,
      clockMeasuredAt: new Date(localNowMs).toISOString(),
      clockUncertaintyMs: 100,
    });
    expect(remainingTimerMilliseconds(timer, clock)).toBe(1_020_000);
    expect(remainingTimerMilliseconds(timer, {
      ...clock,
      nowMs: clock.nowMs + 60_000,
    })).toBe(1_020_000);
  });

  it('clamps elapsed targets and formats stable rounded-up seconds', () => {
    const clock = estimateServerNow({
      localNowMs: Date.parse('2026-07-13T04:30:00.000Z'),
      clockOffsetMs: 0,
      clockMeasuredAt: '2026-07-13T04:30:00.000Z',
      clockUncertaintyMs: 0,
    });
    expect(remainingTimerMilliseconds(activeTimer(), clock)).toBe(0);
    expect(formatTimerClock(60_001)).toBe('01:01');
    expect(formatTimerClock(60_000)).toBe('01:00');
    expect(formatTimerClock(0)).toBe('00:00');
  });

  it('waits past zero by the measured half-RTT before auto-completing', () => {
    const timer = activeTimer({
      targetEndAt: '2026-07-13T04:10:00.000Z',
    });
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 399,
      uncertaintyMs: 400,
      calibration: 'calibrated',
      reliable: true,
    }, { provisional: false })).toBe(false);
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 400,
      uncertaintyMs: 400,
      calibration: 'calibrated',
      reliable: true,
    }, { provisional: false })).toBe(true);
  });

  it('uses high uncertainty as a safety boundary before completing', () => {
    const timer = activeTimer({
      targetEndAt: '2026-07-13T04:10:00.000Z',
    });
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 4_999,
      uncertaintyMs: 5_000,
      calibration: 'uncertain',
      reliable: false,
    }, { provisional: false })).toBe(false);
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 5_000,
      uncertaintyMs: 5_000,
      calibration: 'uncertain',
      reliable: false,
    }, { provisional: false })).toBe(true);
  });

  it('keeps the known uncertainty boundary for stale calibration', () => {
    const timer = activeTimer({
      targetEndAt: '2026-07-13T04:10:00.000Z',
    });
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 999,
      uncertaintyMs: 1_000,
      calibration: 'stale',
      reliable: false,
    }, { provisional: false })).toBe(false);
    expect(shouldAutoCompleteTimer(timer, {
      nowMs: localNowMs + 1_000,
      uncertaintyMs: 1_000,
      calibration: 'stale',
      reliable: false,
    }, { provisional: false })).toBe(true);
  });

  it('blocks an uncalibrated confirmed timer but allows a provisional timer', () => {
    const timer = activeTimer({
      targetEndAt: '2026-07-13T04:10:00.000Z',
    });
    const missingClock = {
      nowMs: localNowMs,
      uncertaintyMs: 0,
      calibration: 'missing' as const,
      reliable: false,
    };
    expect(shouldAutoCompleteTimer(
      timer, missingClock, { provisional: false },
    )).toBe(false);
    expect(shouldAutoCompleteTimer(
      timer, missingClock, { provisional: true },
    )).toBe(true);
  });
});
