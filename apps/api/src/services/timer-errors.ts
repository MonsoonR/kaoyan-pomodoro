import type { ActiveTimer } from '@kaoyan/contracts';

export type TimerErrorCode =
  | 'TIMER_NOT_ACTIVE'
  | 'TIMER_ALREADY_ACTIVE'
  | 'TIMER_ID_ALREADY_USED'
  | 'STALE_TIMER_VERSION'
  | 'INVALID_TIMER_STATE'
  | 'TIMER_NOT_ELAPSED'
  | 'TIMER_ALREADY_ELAPSED'
  | 'TIMER_ALREADY_FINALIZED'
  | 'DAILY_TASK_NOT_AVAILABLE'
  | 'INVALID_DAILY_TASK_STATE'
  | 'ACTIVE_TIMER_TASK_LOCKED'
  | 'SERVER_TIME_MOVED_BACKWARDS';

const messages: Record<TimerErrorCode, string> = {
  TIMER_NOT_ACTIVE: 'Timer is not active',
  TIMER_ALREADY_ACTIVE: 'Another timer is already active',
  TIMER_ID_ALREADY_USED: 'Timer id has already been used',
  STALE_TIMER_VERSION: 'Timer version is stale',
  INVALID_TIMER_STATE: 'Timer state does not allow this operation',
  TIMER_NOT_ELAPSED: 'Timer has not elapsed',
  TIMER_ALREADY_ELAPSED: 'Timer has already elapsed',
  TIMER_ALREADY_FINALIZED: 'Timer was already finalized differently',
  DAILY_TASK_NOT_AVAILABLE: 'Daily task is not available',
  INVALID_DAILY_TASK_STATE: 'Daily task state does not allow this timer',
  ACTIVE_TIMER_TASK_LOCKED: 'Daily task is locked by an active timer',
  SERVER_TIME_MOVED_BACKWARDS: 'Server time moved backwards',
};

export class TimerError extends Error {
  constructor(readonly code: TimerErrorCode) {
    super(messages[code]);
  }
}

export class StaleTimerVersionError extends TimerError {
  constructor(
    readonly currentVersion: number,
    readonly currentTimer: ActiveTimer,
    readonly serverTime: string,
  ) {
    super('STALE_TIMER_VERSION');
  }
}
