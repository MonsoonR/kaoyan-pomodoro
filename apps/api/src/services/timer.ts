import type {
  ActiveTimer,
  CompleteTimerRequest,
  ExitTimerRequest,
  FocusSession,
  PauseTimerRequest,
  ResumeTimerRequest,
  StartTimerRequest,
} from '@kaoyan/contracts';
import {
  defaultChangeLogWriter,
  type ChangeLogWriter,
  type ServiceDependencies,
} from './common';
import {
  getFocusSession,
  insertFocusSession,
  type NewFocusSession,
} from './focus-sessions';
import {
  StaleTimerVersionError,
  TimerError,
} from './timer-errors';
import { StaleVersionError } from './errors';
import {
  activeTimerSelect,
  serializeActiveTimer,
  type ActiveTimerRow,
} from './timer-serialization';

interface DailyTaskRow {
  id: string;
  title: string;
  subject: string;
  pomodoro_target: number;
  pomodoro_completed: number;
  status: 'pending' | 'active' | 'awaiting_confirmation' | 'completed';
  version: number;
  deleted_at: number | null;
}

export interface TimerDependencies extends ServiceDependencies {
  insertSession?: typeof insertFocusSession;
}

export interface StartTimerResult {
  outcome: 'started' | 'existing';
  timer: ActiveTimer;
  serverTime: string;
}

export interface FinalizationResult {
  outcome: 'finalized' | 'alreadyFinalized';
  focusSession: FocusSession;
  serverTime: string;
}

export function createTimerService(deps: TimerDependencies) {
  const write: ChangeLogWriter = deps.writeChange ?? defaultChangeLogWriter;
  const insertSession = deps.insertSession ?? insertFocusSession;
  const getTimerRow = (userId: string, id: string) =>
    deps.sqlite
      .prepare(`${activeTimerSelect} WHERE id=? AND user_id=?`)
      .get(id, userId) as ActiveTimerRow | undefined;
  const getLiveTimerRow = (userId: string) =>
    deps.sqlite
      .prepare(`${activeTimerSelect} WHERE user_id=? AND deleted_at IS NULL`)
      .get(userId) as ActiveTimerRow | undefined;
  const getDaily = (userId: string, id: string) =>
    deps.sqlite
      .prepare(`SELECT id,title,subject,pomodoro_target,pomodoro_completed,
        status,version,deleted_at FROM daily_tasks WHERE id=? AND user_id=?`)
      .get(id, userId) as DailyTaskRow | undefined;
  const serverNow = () => {
    const date = deps.now();
    return { milliseconds: date.getTime(), iso: date.toISOString() };
  };
  const writeTimer = (
    userId: string,
    timer: ActiveTimer,
    changeType: 'upsert' | 'delete',
    changedAt: number,
  ) =>
    write(deps.sqlite, {
      userId,
      entityType: 'activeTimer',
      entityId: timer.id,
      version: timer.version,
      changeType,
      payload: changeType === 'delete' ? null : timer,
      changedAt,
    });
  const writeDaily = (userId: string, dailyTaskId: string, changedAt: number) => {
    const row = deps.sqlite
      .prepare(`SELECT id,source_task_id,date,title,subject,pomodoro_target,
        pomodoro_completed,timer_preset,status,sort_order,completed_at,version,
        created_at,updated_at,deleted_at FROM daily_tasks WHERE id=? AND user_id=?`)
      .get(dailyTaskId, userId) as Record<string, unknown> | undefined;
    if (!row) throw new TimerError('DAILY_TASK_NOT_AVAILABLE');
    const payload = {
      id: row.id,
      sourceTaskId: row.source_task_id,
      date: row.date,
      title: row.title,
      subject: row.subject,
      pomodoroTarget: row.pomodoro_target,
      pomodoroCompleted: row.pomodoro_completed,
      timerPreset: row.timer_preset,
      status: row.status,
      sortOrder: row.sort_order,
      completedAt:
        row.completed_at === null
          ? null
          : new Date(row.completed_at as number).toISOString(),
      version: row.version as number,
      createdAt: new Date(row.created_at as number).toISOString(),
      updatedAt: new Date(row.updated_at as number).toISOString(),
      deletedAt:
        row.deleted_at === null
          ? null
          : new Date(row.deleted_at as number).toISOString(),
    };
    write(deps.sqlite, {
      userId,
      entityType: 'dailyTask',
      entityId: dailyTaskId,
      version: row.version as number,
      changeType: 'upsert',
      payload,
      changedAt,
    });
  };
  const requireLive = (userId: string, timerId: string) => {
    const row = getTimerRow(userId, timerId);
    if (!row || row.deleted_at !== null) throw new TimerError('TIMER_NOT_ACTIVE');
    return row;
  };
  const requireVersion = (
    row: ActiveTimerRow,
    expectedVersion: number,
    nowIso: string,
  ) => {
    if (row.version !== expectedVersion) {
      const current = serializeActiveTimer(row);
      throw new StaleTimerVersionError(row.version, current, nowIso);
    }
  };
  const finalized = (
    userId: string,
    timerId: string,
    requested: 'completed' | 'interrupted',
    serverTime: string,
  ): FinalizationResult | null => {
    const session = getFocusSession(deps.sqlite, userId, timerId);
    if (!session) return null;
    if (session.result !== requested)
      throw new TimerError('TIMER_ALREADY_FINALIZED');
    return { outcome: 'alreadyFinalized', focusSession: session, serverTime };
  };

  const finalize = (
    userId: string,
    timerId: string,
    input: CompleteTimerRequest | ExitTimerRequest,
    result: 'completed' | 'interrupted',
  ): FinalizationResult =>
    deps.sqlite.transaction(() => {
      const now = serverNow();
      const prior = finalized(userId, timerId, result, now.iso);
      if (prior) return prior;
      const row = requireLive(userId, timerId);
      requireVersion(row, input.expectedVersion, now.iso);
      if (now.milliseconds < row.started_at)
        throw new TimerError('SERVER_TIME_MOVED_BACKWARDS');
      if (result === 'completed') {
        if (row.status !== 'running') throw new TimerError('INVALID_TIMER_STATE');
        if (now.milliseconds < row.target_end_at)
          throw new TimerError('TIMER_NOT_ELAPSED');
      }
      const interruptionReason =
        result === 'interrupted'
          ? (input as ExitTimerRequest).reason
          : row.interruption_reason;
      const reference =
        row.status === 'paused' ? (row.paused_at as number) : now.milliseconds;
      const secondsRemaining = Math.ceil(
        Math.max(0, row.target_end_at - reference) / 1000,
      );
      const effectiveSeconds =
        result === 'completed'
          ? row.planned_seconds
          : Math.max(
              0,
              Math.min(row.planned_seconds, row.planned_seconds - secondsRemaining),
            );

      if (row.phase === 'focus') {
        const daily = getDaily(userId, row.daily_task_id);
        if (!daily || daily.deleted_at !== null)
          throw new TimerError('DAILY_TASK_NOT_AVAILABLE');
        if (daily.status !== 'active')
          throw new TimerError('INVALID_DAILY_TASK_STATE');
        if (result === 'completed') {
          const completed = daily.pomodoro_completed + 1;
          const status =
            completed >= daily.pomodoro_target
              ? 'awaiting_confirmation'
              : 'pending';
          deps.sqlite.prepare(`UPDATE daily_tasks SET pomodoro_completed=?,
            status=?,completed_at=NULL,version=version+1,updated_at=?
            WHERE id=? AND user_id=?`).run(
            completed,status,now.milliseconds,row.daily_task_id,userId,
          );
        } else {
          deps.sqlite.prepare(`UPDATE daily_tasks SET status='pending',
            completed_at=NULL,version=version+1,updated_at=?
            WHERE id=? AND user_id=?`).run(
            now.milliseconds,row.daily_task_id,userId,
          );
        }
        writeDaily(userId, row.daily_task_id, now.milliseconds);
      }

      const sessionInput: NewFocusSession = {
        id: row.id,
        userId,
        dailyTaskId: row.daily_task_id,
        taskTitle: row.task_title,
        subject: row.subject,
        phase: row.phase,
        plannedSeconds: row.planned_seconds,
        effectiveSeconds,
        startedAt: row.started_at,
        endedAt: now.milliseconds,
        result,
        interruptionReason,
      };
      const session = insertSession(deps.sqlite, sessionInput);
      write(deps.sqlite, {
        userId,
        entityType: 'focusSession',
        entityId: session.id,
        version: 1,
        changeType: 'upsert',
        payload: session,
        changedAt: now.milliseconds,
      });
      deps.sqlite.prepare(`UPDATE active_timer SET interruption_reason=?,
        version=version+1,updated_at=?,deleted_at=? WHERE id=? AND user_id=?
        AND deleted_at IS NULL`).run(
        interruptionReason,now.milliseconds,now.milliseconds,timerId,userId,
      );
      const deletedRow = getTimerRow(userId, timerId);
      if (!deletedRow) throw new TimerError('TIMER_NOT_ACTIVE');
      writeTimer(
        userId,
        serializeActiveTimer(deletedRow),
        'delete',
        now.milliseconds,
      );
      return {
        outcome: 'finalized' as const,
        focusSession: session,
        serverTime: now.iso,
      };
    })();

  return {
    getTimerVersion(userId: string, timerId: string) {
      return getTimerRow(userId, timerId)?.version ?? null;
    },
    getActiveTimer(userId: string) {
      const now = serverNow();
      const row = getLiveTimerRow(userId);
      return {
        timer: row ? serializeActiveTimer(row) : null,
        serverTime: now.iso,
      };
    },
    startTimer(userId: string, input: StartTimerRequest): StartTimerResult {
      return deps.sqlite.transaction(() => {
        const now = serverNow();
        const current = getLiveTimerRow(userId);
        if (current)
          return {
            outcome: 'existing' as const,
            timer: serializeActiveTimer(current),
            serverTime: now.iso,
          };
        if (
          getTimerRow(userId, input.id) ||
          getFocusSession(deps.sqlite, userId, input.id)
        )
          throw new TimerError('TIMER_ID_ALREADY_USED');
        const daily = getDaily(userId, input.dailyTaskId);
        if (!daily || daily.deleted_at !== null)
          throw new TimerError('DAILY_TASK_NOT_AVAILABLE');
        if (daily.version !== input.dailyTaskVersion)
          throw new StaleVersionError(daily.version);
        if (daily.status !== 'pending')
          throw new TimerError('INVALID_DAILY_TASK_STATE');
        if (input.phase === 'focus') {
          deps.sqlite.prepare(`UPDATE daily_tasks SET status='active',
            version=version+1,updated_at=? WHERE id=? AND user_id=?
            AND version=? AND deleted_at IS NULL`).run(
            now.milliseconds,input.dailyTaskId,userId,input.dailyTaskVersion,
          );
          writeDaily(userId, input.dailyTaskId, now.milliseconds);
        }
        deps.sqlite.prepare(`INSERT INTO active_timer(
          id,singleton_key,user_id,daily_task_id,task_title,subject,phase,status,
          planned_seconds,started_at,target_end_at,paused_at,
          accumulated_paused_seconds,interruption_reason,version,created_at,
          updated_at,deleted_at
        ) VALUES (?,1,?,?,?,?,?,'running',?,?,?,NULL,0,NULL,1,?,?,NULL)`).run(
          input.id,userId,input.dailyTaskId,daily.title,daily.subject,input.phase,
          input.plannedSeconds,now.milliseconds,
          now.milliseconds + input.plannedSeconds * 1000,
          now.milliseconds,now.milliseconds,
        );
        const timer = serializeActiveTimer(requireLive(userId, input.id));
        writeTimer(userId, timer, 'upsert', now.milliseconds);
        return { outcome: 'started' as const, timer, serverTime: now.iso };
      }).immediate();
    },
    pauseTimer(userId: string, timerId: string, input: PauseTimerRequest) {
      return deps.sqlite.transaction(() => {
        const now = serverNow();
        const row = requireLive(userId, timerId);
        requireVersion(row, input.expectedVersion, now.iso);
        if (now.milliseconds < row.started_at)
          throw new TimerError('SERVER_TIME_MOVED_BACKWARDS');
        if (row.status !== 'running') throw new TimerError('INVALID_TIMER_STATE');
        if (now.milliseconds >= row.target_end_at)
          throw new TimerError('TIMER_ALREADY_ELAPSED');
        deps.sqlite.prepare(`UPDATE active_timer SET status='paused',paused_at=?,
          interruption_reason=?,version=version+1,updated_at=?
          WHERE id=? AND user_id=? AND version=? AND deleted_at IS NULL`).run(
          now.milliseconds,input.reason,now.milliseconds,timerId,userId,row.version,
        );
        const timer = serializeActiveTimer(requireLive(userId, timerId));
        writeTimer(userId, timer, 'upsert', now.milliseconds);
        return { timer, serverTime: now.iso };
      })();
    },
    resumeTimer(userId: string, timerId: string, input: ResumeTimerRequest) {
      return deps.sqlite.transaction(() => {
        const now = serverNow();
        const row = requireLive(userId, timerId);
        requireVersion(row, input.expectedVersion, now.iso);
        if (row.status !== 'paused' || row.paused_at === null)
          throw new TimerError('INVALID_TIMER_STATE');
        const pauseDuration = now.milliseconds - row.paused_at;
        if (pauseDuration < 0)
          throw new TimerError('SERVER_TIME_MOVED_BACKWARDS');
        deps.sqlite.prepare(`UPDATE active_timer SET status='running',
          paused_at=NULL,target_end_at=target_end_at+?,
          accumulated_paused_seconds=accumulated_paused_seconds+?,
          version=version+1,updated_at=? WHERE id=? AND user_id=?
          AND version=? AND deleted_at IS NULL`).run(
          pauseDuration,Math.floor(pauseDuration / 1000),now.milliseconds,
          timerId,userId,row.version,
        );
        const timer = serializeActiveTimer(requireLive(userId, timerId));
        writeTimer(userId, timer, 'upsert', now.milliseconds);
        return { timer, serverTime: now.iso };
      })();
    },
    completeTimer(userId: string, timerId: string, input: CompleteTimerRequest) {
      return finalize(userId, timerId, input, 'completed');
    },
    exitTimer(userId: string, timerId: string, input: ExitTimerRequest) {
      return finalize(userId, timerId, input, 'interrupted');
    },
  };
}
