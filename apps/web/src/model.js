export const SUBJECTS = {
  math: '数学',
  english: '英语',
  politics: '政治',
  '408': '408',
  other: '其他',
};

export const PRESETS = {
  '25-5': '25 / 5',
  '50-10': '50 / 10',
  custom: '自定义',
};

export const DEFAULT_SETTINGS = {
  defaultPreset: '50-10',
  customFocusMinutes: 40,
  customShortBreakMinutes: 8,
  customLongBreakMinutes: 20,
  longBreakInterval: 4,
  soundEnabled: true,
  notificationsEnabled: false,
};

const STORAGE_KEY = 'kaoyan-pomodoro-state-v1';

export function makeId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getIsoDateKey(iso) {
  return getDateKey(new Date(iso));
}

export function createInitialState(now = new Date()) {
  const iso = now.toISOString();
  const seed = [
    ['高数基础课程', 'math', 2, '50-10'],
    ['高数练习 30 道', 'math', 2, '50-10'],
    ['数据结构章节复习', '408', 2, '50-10'],
    ['英语单词 100 个', 'english', 2, '25-5'],
    ['马原章节复习', 'politics', 1, '25-5'],
  ];
  return {
    version: 1,
    templates: seed.map(([title, subject, target, preset]) => ({
      id: makeId(),
      title,
      subject,
      defaultPomodoroTarget: target,
      defaultTimerPreset: preset,
      archived: false,
      createdAt: iso,
      updatedAt: iso,
    })),
    dailyTasks: [],
    sessions: [],
    settings: { ...DEFAULT_SETTINGS },
    runningTimer: null,
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeState(value) {
  if (!isRecord(value) || !Array.isArray(value.templates) || !Array.isArray(value.dailyTasks) || !Array.isArray(value.sessions)) {
    throw new Error('数据文件格式无效');
  }
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    version: 1,
    templates: value.templates,
    dailyTasks: value.dailyTasks,
    sessions: value.sessions,
    settings: {
      defaultPreset: ['25-5', '50-10', 'custom'].includes(settings.defaultPreset) ? settings.defaultPreset : DEFAULT_SETTINGS.defaultPreset,
      customFocusMinutes: Number.isFinite(settings.customFocusMinutes) ? settings.customFocusMinutes : DEFAULT_SETTINGS.customFocusMinutes,
      customShortBreakMinutes: Number.isFinite(settings.customShortBreakMinutes) ? settings.customShortBreakMinutes : DEFAULT_SETTINGS.customShortBreakMinutes,
      customLongBreakMinutes: Number.isFinite(settings.customLongBreakMinutes) ? settings.customLongBreakMinutes : DEFAULT_SETTINGS.customLongBreakMinutes,
      longBreakInterval: Number.isFinite(settings.longBreakInterval) ? settings.longBreakInterval : DEFAULT_SETTINGS.longBreakInterval,
      soundEnabled: typeof settings.soundEnabled === 'boolean' ? settings.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
      notificationsEnabled: typeof settings.notificationsEnabled === 'boolean' ? settings.notificationsEnabled : DEFAULT_SETTINGS.notificationsEnabled,
    },
    runningTimer: isRecord(value.runningTimer) ? value.runningTimer : null,
  };
}

export function loadState() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return createInitialState();
  }
}

export function saveState(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The in-memory app remains usable when storage is unavailable.
  }
}

export function clearStoredState() {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

export function getDurations(settings, preset) {
  if (preset === '25-5') return { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 20 * 60 };
  if (preset === '50-10') return { focus: 50 * 60, shortBreak: 10 * 60, longBreak: 20 * 60 };
  return {
    focus: Math.max(1, Number(settings.customFocusMinutes) || DEFAULT_SETTINGS.customFocusMinutes) * 60,
    shortBreak: Math.max(1, Number(settings.customShortBreakMinutes) || DEFAULT_SETTINGS.customShortBreakMinutes) * 60,
    longBreak: Math.max(1, Number(settings.customLongBreakMinutes) || DEFAULT_SETTINGS.customLongBreakMinutes) * 60,
  };
}

export function createRunningTimer(taskId, phase, plannedSeconds, now = new Date()) {
  return {
    taskId,
    phase,
    plannedSeconds,
    startedAt: now.toISOString(),
    targetEndAt: new Date(now.getTime() + plannedSeconds * 1000).toISOString(),
    pausedAt: null,
    accumulatedPausedSeconds: 0,
    interruptionReason: null,
  };
}

export function remainingSeconds(timer, now = new Date()) {
  if (!timer) return 0;
  const reference = timer.pausedAt ? new Date(timer.pausedAt) : now;
  return Math.max(0, Math.ceil((new Date(timer.targetEndAt).getTime() - reference.getTime()) / 1000));
}

export function elapsedSeconds(timer, now = new Date()) {
  return Math.max(0, Math.min(timer.plannedSeconds, timer.plannedSeconds - remainingSeconds(timer, now)));
}

export function pauseTimer(timer, reason, now = new Date()) {
  const clean = reason.trim();
  if (!clean) throw new Error('请选择或填写中断原因');
  return {
    ...timer,
    pausedAt: now.toISOString(),
    interruptionReason: timer.interruptionReason ? `${timer.interruptionReason}、${clean}` : clean,
  };
}

export function resumeTimer(timer, now = new Date()) {
  if (!timer.pausedAt) return timer;
  const pausedMs = Math.max(0, now.getTime() - new Date(timer.pausedAt).getTime());
  return {
    ...timer,
    targetEndAt: new Date(new Date(timer.targetEndAt).getTime() + pausedMs).toISOString(),
    pausedAt: null,
    accumulatedPausedSeconds: timer.accumulatedPausedSeconds + Math.round(pausedMs / 1000),
  };
}

export function restartTimer(timer, now = new Date()) {
  return createRunningTimer(timer.taskId, timer.phase, timer.plannedSeconds, now);
}

export function nextBreakPhase(completedPomodoros, interval) {
  return completedPomodoros > 0 && completedPomodoros % interval === 0 ? 'long_break' : 'short_break';
}

export function isExpiredTimer(timer, now = new Date()) {
  return Boolean(timer && !timer.pausedAt && new Date(timer.targetEndAt).getTime() <= now.getTime());
}

export function getTodayTasks(tasks, dateKey = getDateKey()) {
  return tasks.filter((task) => task.date === dateKey).slice().sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getSummary(tasks, sessions, dateKey = getDateKey()) {
  const todayTasks = tasks.filter((task) => task.date === dateKey);
  const todaySessions = sessions.filter((session) => getIsoDateKey(session.startedAt) === dateKey && session.phase === 'focus');
  return {
    total: todayTasks.length,
    completed: todayTasks.filter((task) => task.status === 'completed').length,
    focusSeconds: todaySessions.reduce((sum, session) => sum + Math.max(0, session.effectiveSeconds || 0), 0),
    pomodoros: todaySessions.filter((session) => session.result === 'completed').length,
    interruptions: todaySessions.filter((session) => session.result === 'interrupted' || session.interruptionReason).length,
  };
}

export function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}`;
  if (minutes) return `${minutes} 分钟`;
  return `${safe} 秒`;
}

export function formatClock(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export function validateTaskInput(input) {
  const title = String(input.title ?? '').trim();
  const target = Number(input.target);
  if (!title || title.length > 60) throw new Error('任务名称需为 1–60 个字符');
  if (!Number.isInteger(target) || target < 1 || target > 12) throw new Error('预计番茄数需为 1–12');
  if (!Object.hasOwn(SUBJECTS, input.subject)) throw new Error('请选择科目');
  if (!Object.hasOwn(PRESETS, input.preset)) throw new Error('请选择计时模式');
  return { title, subject: input.subject, target, preset: input.preset };
}
