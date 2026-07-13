import type {
  ActiveTimer,
  Conflict,
  CurrentSession,
  DailyTask,
  Settings,
  Task,
} from '@kaoyan/contracts';

export const USER_A = '00000000-0000-4000-8000-000000000001';
export const USER_B = '00000000-0000-4000-8000-000000000002';
export const DEVICE_ID = '00000000-0000-4000-8000-000000000003';
export const TASK_ID = '00000000-0000-4000-8000-000000000010';
export const DAILY_ID = '00000000-0000-4000-8000-000000000020';
export const SETTINGS_ID = '00000000-0000-4000-8000-000000000030';
export const TIMER_ID = '00000000-0000-4000-8000-000000000040';
export const CONFLICT_ID = '00000000-0000-4000-8000-000000000050';
export const NOW = '2026-07-13T04:00:00.000Z';

export function session(userId = USER_A): CurrentSession {
  return {
    user: { id: userId, username: userId === USER_A ? 'student-a' : 'student-b' },
    deviceId: DEVICE_ID,
    deviceName: 'Test browser',
    expiresAt: '2026-07-14T04:00:00.000Z',
  };
}

export function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'Linear algebra',
    subject: 'Math',
    defaultPomodoroTarget: 4,
    defaultTimerPreset: '25-5',
    notes: null,
    archived: false,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

export function dailyTask(overrides: Partial<DailyTask> = {}): DailyTask {
  return {
    id: DAILY_ID,
    sourceTaskId: TASK_ID,
    date: '2026-07-13',
    title: 'Linear algebra',
    subject: 'Math',
    pomodoroTarget: 4,
    pomodoroCompleted: 0,
    timerPreset: '25-5',
    status: 'pending',
    sortOrder: 0,
    completedAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    id: SETTINGS_ID,
    defaultPreset: '25-5',
    customFocusMinutes: 25,
    customShortBreakMinutes: 5,
    customLongBreakMinutes: 15,
    longBreakInterval: 4,
    soundEnabled: true,
    notificationsEnabled: false,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

export function activeTimer(
  overrides: Partial<Extract<ActiveTimer, { status: 'running' }>> = {},
): ActiveTimer {
  return {
    id: TIMER_ID,
    dailyTaskId: DAILY_ID,
    taskTitle: 'Linear algebra',
    subject: 'Math',
    phase: 'focus',
    plannedSeconds: 1500,
    startedAt: NOW,
    targetEndAt: '2026-07-13T04:25:00.000Z',
    accumulatedPausedSeconds: 0,
    interruptionReason: null,
    status: 'running',
    pausedAt: null,
    version: 1,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

export function conflict(overrides: Partial<Conflict> = {}): Conflict {
  return {
    id: CONFLICT_ID,
    entityType: 'task',
    entityId: TASK_ID,
    conflictType: 'delete_modify',
    localOperationId: '00000000-0000-4000-8000-000000000060',
    baseVersion: 1,
    serverVersion: 2,
    localPayload: {},
    serverPayload: task({ version: 2 }),
    status: 'open',
    resolution: null,
    resolutionResult: null,
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  } as Conflict;
}
