import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState,
  createRunningTimer,
  elapsedSeconds,
  getDateKey,
  getDurations,
  getSummary,
  isExpiredTimer,
  nextBreakPhase,
  normalizeState,
  pauseTimer,
  remainingSeconds,
  resumeTimer,
} from '../src/model.js';

test('initial state includes reusable study templates', () => {
  const state = createInitialState(new Date('2026-07-12T08:00:00Z'));
  assert.equal(state.templates.length, 5);
  assert.equal(state.runningTimer, null);
});

test('date keys use local calendar fields', () => {
  const date = new Date(2026, 6, 12, 23, 30);
  assert.equal(getDateKey(date), '2026-07-12');
});

test('custom durations use saved minutes', () => {
  const durations = getDurations({ customFocusMinutes: 40, customShortBreakMinutes: 8, customLongBreakMinutes: 25 }, 'custom');
  assert.deepEqual(durations, { focus: 2400, shortBreak: 480, longBreak: 1500 });
});

test('pause freezes remaining time and resume shifts target end', () => {
  const timer = createRunningTimer('task-1', 'focus', 1500, new Date('2026-07-12T10:00:00Z'));
  const paused = pauseTimer(timer, '查资料', new Date('2026-07-12T10:10:00Z'));
  assert.equal(remainingSeconds(paused, new Date('2026-07-12T10:20:00Z')), 900);
  const resumed = resumeTimer(paused, new Date('2026-07-12T10:20:00Z'));
  assert.equal(resumed.targetEndAt, '2026-07-12T10:35:00.000Z');
  assert.equal(resumed.interruptionReason, '查资料');
});

test('elapsed time excludes paused duration', () => {
  const timer = createRunningTimer('task-1', 'focus', 1500, new Date('2026-07-12T10:00:00Z'));
  const paused = pauseTimer(timer, '临时有事', new Date('2026-07-12T10:05:00Z'));
  assert.equal(elapsedSeconds(paused, new Date('2026-07-12T10:20:00Z')), 300);
});

test('summary reports completed tasks, focus time, pomodoros and interruptions', () => {
  const date = '2026-07-12';
  const tasks = [{ id: 'a', date, status: 'completed' }, { id: 'b', date, status: 'pending' }];
  const sessions = [
    { startedAt: '2026-07-12T09:00:00', phase: 'focus', result: 'completed', effectiveSeconds: 1500 },
    { startedAt: '2026-07-12T10:00:00', phase: 'focus', result: 'interrupted', effectiveSeconds: 600 },
  ];
  assert.deepEqual(getSummary(tasks, sessions, date), { total: 2, completed: 1, focusSeconds: 2100, pomodoros: 1, interruptions: 1 });
});

test('expired running timers are detected only while active', () => {
  const timer = createRunningTimer('task-1', 'focus', 60, new Date('2026-07-12T10:00:00Z'));
  assert.equal(isExpiredTimer(timer, new Date('2026-07-12T10:01:01Z')), true);
  const paused = pauseTimer(timer, '临时有事', new Date('2026-07-12T10:00:30Z'));
  assert.equal(isExpiredTimer(paused, new Date('2026-07-12T10:02:00Z')), false);
});

test('long break is selected at the configured interval', () => {
  assert.equal(nextBreakPhase(4, 4), 'long_break');
  assert.equal(nextBreakPhase(3, 4), 'short_break');
});

test('invalid imported data is rejected', () => {
  assert.throws(() => normalizeState({ templates: 'bad' }), /数据文件格式无效/);
});
