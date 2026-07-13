import type { ActiveTimer } from '@kaoyan/contracts';
import type { LocalTimerProjection } from '../../db/types';

export const MAX_CLOCK_CALIBRATION_AGE_MS = 2 * 60_000;
export const MAX_CLOCK_UNCERTAINTY_MS = 2_000;

export type ClockCalibration =
  | 'calibrated'
  | 'missing'
  | 'stale'
  | 'uncertain';

export interface EstimatedServerClock {
  nowMs: number;
  uncertaintyMs: number;
  calibration: ClockCalibration;
  reliable: boolean;
}

export function estimateServerNow(input: {
  localNowMs: number;
  clockOffsetMs: number | null;
  clockMeasuredAt: string | null;
  clockUncertaintyMs: number | null;
}): EstimatedServerClock {
  const uncertaintyMs = Math.max(0, input.clockUncertaintyMs ?? 0);
  if (input.clockOffsetMs === null || input.clockMeasuredAt === null) {
    return {
      nowMs: input.localNowMs,
      uncertaintyMs,
      calibration: 'missing',
      reliable: false,
    };
  }
  const measuredAtMs = Date.parse(input.clockMeasuredAt);
  const stale = !Number.isFinite(measuredAtMs) ||
    input.localNowMs - measuredAtMs > MAX_CLOCK_CALIBRATION_AGE_MS;
  const uncertain = uncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS;
  return {
    nowMs: input.localNowMs + input.clockOffsetMs,
    uncertaintyMs,
    calibration: stale ? 'stale' : uncertain ? 'uncertain' : 'calibrated',
    reliable: !stale && !uncertain,
  };
}

type VisibleTimer = ActiveTimer | LocalTimerProjection;

export function remainingTimerMilliseconds(
  timer: VisibleTimer,
  clock: EstimatedServerClock,
): number {
  const pausedAt = timer.pausedAt;
  const referenceMs = pausedAt === null ? clock.nowMs : Date.parse(pausedAt);
  return Math.max(0, Date.parse(timer.targetEndAt) - referenceMs);
}

export function formatTimerClock(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function shouldAutoCompleteTimer(
  timer: VisibleTimer,
  clock: EstimatedServerClock,
): boolean {
  if (timer.status !== 'running' && timer.status !== 'starting' &&
      timer.status !== 'resuming') return false;
  const conservativeDelay = clock.calibration === 'calibrated'
    ? clock.uncertaintyMs
    : 0;
  return clock.nowMs - conservativeDelay >= Date.parse(timer.targetEndAt);
}

export function calibrationLabel(clock: EstimatedServerClock): string {
  if (clock.calibration === 'calibrated') return '已按服务器时间校准';
  if (clock.calibration === 'missing') return '等待时间校准 · 本机估算';
  if (clock.calibration === 'stale') return '校准已过期 · 本机估算';
  return '网络时延较高 · 本机估算';
}
