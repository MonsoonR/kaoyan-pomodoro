import type { ActiveTimer } from '@kaoyan/contracts';
import type {
  LocalTimerProjection,
  OperationRow,
  SyncIssueRow,
} from '../../db/types';
import { projectTimer } from '../../sync/projector';

export type TimerViewState =
  | 'none'
  | 'starting'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'completing'
  | 'exiting'
  | 'reconciling';

export interface TimerReconciliationModel {
  operationId: string;
  operationCreatedAt: string;
  attemptedAction: string;
  errorCode: string;
  explanation: string;
  serverDescription: string;
  canRetry: boolean;
  canSwitchToTimer: boolean;
}

export interface TimerViewModel {
  state: TimerViewState;
  timer: ActiveTimer | LocalTimerProjection | null;
  serverTimer: ActiveTimer | null;
  pending: boolean;
  provisional: boolean;
  reconciliation: TimerReconciliationModel | null;
}

const ACTION_NAMES = {
  timerStart: '开始',
  timerPause: '暂停',
  timerResume: '继续',
  timerComplete: '完成',
  timerExit: '提前退出',
} as const;

const ERROR_EXPLANATIONS: Record<string, string> = {
  TIMER_ALREADY_ACTIVE: '其他设备已经启动了一个计时器。',
  STALE_TIMER_VERSION: '计时状态已经变化，请确认要保留的内容。',
  TIMER_NOT_ACTIVE: '这个计时已经结束。',
  TIMER_ALREADY_FINALIZED: '计时器已经在其他设备完成或退出。',
  INVALID_TIMER_STATE: '当前计时状态无法执行这个操作。',
  INVALID_DAILY_TASK_STATE: '今日任务当前状态不允许启动计时器。',
  TIMER_ALREADY_ELAPSED: '这个计时已经到时。',
  TIMER_NOT_ELAPSED: '计时尚未到时，将继续倒计时。',
  DAILY_TASK_NOT_AVAILABLE: '对应的今日任务已不可用。',
  ACTIVE_TIMER_TASK_LOCKED: '今日任务正由另一个活动计时器占用。',
};

function compatibleRetry(
  operation: OperationRow['operation'],
  timer: ActiveTimer | null,
): boolean {
  if (operation.operationType === 'timerStart') return timer === null;
  if (!timer || timer.id !== operation.entityId) return false;
  if (operation.operationType === 'timerPause') return timer.status === 'running';
  if (operation.operationType === 'timerResume') return timer.status === 'paused';
  if (operation.operationType === 'timerComplete') return timer.status === 'running';
  return operation.operationType === 'timerExit';
}

export function buildTimerViewModel(input: {
  serverTimer: ActiveTimer | null;
  operations: readonly OperationRow[];
  syncIssues: readonly SyncIssueRow[];
}): TimerViewModel {
  const ordered = [...input.operations].sort(
    (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const active = ordered.filter((row) =>
    row.entityType === 'activeTimer' &&
    (row.state === 'pending' || row.state === 'acknowledged'));
  const timer = projectTimer(input.serverTimer, active);
  const rejectedById = new Map(
    ordered
      .filter((row) => row.entityType === 'activeTimer' && row.state === 'rejected')
      .map((row) => [row.operationId, row]),
  );
  const issue = [...input.syncIssues]
    .reverse()
    .find((candidate) => rejectedById.has(candidate.operationId));
  let reconciliation: TimerReconciliationModel | null = null;
  if (issue) {
    const row = rejectedById.get(issue.operationId) as OperationRow;
    const operation = row.operation;
    if (operation.entityType !== 'activeTimer')
      throw new Error('Timer issue did not reference a timer operation');
    reconciliation = {
      operationId: issue.operationId,
      operationCreatedAt: operation.createdAt,
      attemptedAction: ACTION_NAMES[operation.operationType],
      errorCode: issue.errorCode,
      explanation: ERROR_EXPLANATIONS[issue.errorCode] ??
        '这次计时操作暂时无法完成。',
      serverDescription: input.serverTimer
        ? `服务器计时器当前为${input.serverTimer.status === 'running' ? '运行中' : '已暂停'}`
        : operation.operationType === 'timerStart'
          ? '服务器当前没有活动计时器'
          : '计时器已在其他设备结束',
      canRetry: ![
        'TIMER_ALREADY_ACTIVE',
        'TIMER_NOT_ELAPSED',
        'TIMER_ALREADY_ELAPSED',
        'DAILY_TASK_NOT_AVAILABLE',
        'INVALID_DAILY_TASK_STATE',
        'ACTIVE_TIMER_TASK_LOCKED',
      ].includes(issue.errorCode) &&
        compatibleRetry(operation, input.serverTimer),
      canSwitchToTimer: issue.errorCode === 'TIMER_ALREADY_ACTIVE' &&
        input.serverTimer !== null,
    };
  }
  const pending = active.length > 0;
  return {
    state: reconciliation ? 'reconciling' : timer?.status ?? 'none',
    timer,
    serverTimer: input.serverTimer,
    pending,
    provisional: timer !== null &&
      (!input.serverTimer || input.serverTimer.id !== timer.id),
    reconciliation,
  };
}
