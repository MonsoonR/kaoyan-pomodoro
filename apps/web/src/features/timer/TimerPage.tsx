import type { DailyTask } from '@kaoyan/contracts';
import { ArrowLeft, CheckCircle2, Clock3 } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { Progress, SubjectBadge } from '../../components.jsx';
import type { LocalDailyTask, LocalTimerProjection } from '../../db/types';
import type { OfflineOperationQueue } from '../../sync/queue';
import { shouldAutoCompleteTimer } from './timer-clock';
import { TimerControls } from './TimerControls';
import { TimerReconciliation } from './TimerReconciliation';
import type { TimerStateSnapshot } from './use-timer-state';

const PHASE_LABELS = {
  focus: '专注',
  short_break: '短休息',
  long_break: '长休息',
} as const;

function localReason(timer: TimerStateSnapshot['viewModel']['timer']): string | null {
  if (!timer) return null;
  return 'reason' in timer
    ? (timer as LocalTimerProjection).reason
    : timer.interruptionReason;
}

export function TimerPage({
  timerState,
  task,
  queue,
  onBack,
  onStartPhase,
  onConfirmTask,
  onTimerSwitch,
  onManualSync,
  onMessage,
}: {
  timerState: TimerStateSnapshot;
  task: DailyTask | LocalDailyTask | null;
  queue: OfflineOperationQueue;
  onBack: () => void;
  onStartPhase: (phase: 'short_break' | 'long_break') => void | Promise<void>;
  onConfirmTask: () => void | Promise<void>;
  onTimerSwitch: (dailyTaskId: string) => void;
  onManualSync: () => void | Promise<void>;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const { viewModel, clock, remainingMs, clockText, clockLabel } = timerState;
  const timer = viewModel.timer;
  const [manualBusy, setManualBusy] = useState(false);

  useEffect(() => {
    if (!timer || viewModel.state === 'reconciling' ||
        !shouldAutoCompleteTimer(timer, clock, {
          provisional: viewModel.provisional,
        })) return;
    void queue.completeTimerOnce(timer.id).catch((error: unknown) =>
      onMessage(error instanceof Error ? error.message : '完成计时器失败', true));
  }, [clock, onMessage, queue, timer, viewModel.provisional, viewModel.state]);

  if (!timer) {
    const awaitingConfirmation = task?.status === 'awaiting_confirmation';
    const reconciliation = viewModel.reconciliation;
    return <section className="focus-page">
      <button className="focus-back" type="button" onClick={onBack}>
        <ArrowLeft size={18} />返回今日任务
      </button>
      <div className="focus-card">
        {reconciliation ? <TimerReconciliation
          model={reconciliation}
          onAdopt={async () => {
            await queue.acknowledgeTimerIssue(reconciliation.operationId);
            onMessage('已采用服务器状态');
          }}
          onRetry={async () => {
            await queue.retryTimerOperation(reconciliation.operationId);
            onMessage(`已重新提交${reconciliation.attemptedAction}操作`);
          }}
          onSwitch={() => {
            if (viewModel.serverTimer)
              onTimerSwitch(viewModel.serverTimer.dailyTaskId);
          }}
        /> : <><div className="completion">
          <i><CheckCircle2 /></i>
          <strong>{task ? '计时器已结束' : '当前没有活动计时器'}</strong>
          <p>权威结果会随同步更新今日任务和专注记录。</p>
        </div>
        {task ? <div className="completion-actions">
          {!awaitingConfirmation ? <>
            <button className="button button--outline button--wide" type="button" onClick={() => void onStartPhase('short_break')}>开始短休息</button>
            <button className="button button--outline button--wide" type="button" onClick={() => void onStartPhase('long_break')}>开始长休息</button>
          </> : <button className="button button--primary button--wide" type="button" onClick={() => void onConfirmTask()}>确认今日任务完成</button>}
          <button className="button button--ghost button--wide" type="button" onClick={onBack}>返回今日任务</button>
        </div> : <button className="button button--primary" type="button" onClick={onBack}>返回今日任务</button>}</>}
      </div>
    </section>;
  }

  const title = 'taskTitle' in timer ? timer.taskTitle : task?.title ?? '正在同步任务';
  const subject = 'subject' in timer ? timer.subject : task?.subject ?? 'other';
  const reason = localReason(timer);
  const progress = timer.plannedSeconds > 0
    ? timer.plannedSeconds - remainingMs / 1_000
    : 0;
  const underlyingState = timer.status;
  const reconciliation = viewModel.reconciliation;
  const ringStyle = {
    '--timer-progress': `${timer.plannedSeconds > 0
      ? Math.min(360, Math.max(0, progress / timer.plannedSeconds * 360))
      : 0}deg`,
  } as CSSProperties;

  return <section className="focus-page">
    <button className="focus-back" type="button" onClick={onBack}>
      <ArrowLeft size={18} />返回今日任务
    </button>
    <div className="focus-timer-layout">
      <header className="focus-timer-heading">
        <SubjectBadge subject={subject} />
        <h1>{title}</h1>
        <p className="timer-identity">计时器 ID：<span data-testid="timer-id">{timer.id}</span></p>
      </header>
      <div className={`timer-circle${underlyingState === 'paused' || underlyingState === 'pausing' ? ' timer-circle--paused' : ''}`} style={ringStyle}>
        <div className="timer-circle__inner">
          <div className="phase" aria-live="polite">
            <Clock3 size={17} />{PHASE_LABELS[timer.phase]}
            <span>{underlyingState === 'paused' || underlyingState === 'pausing' ? '已暂停' : '进行中'}</span>
          </div>
          <div className="timer" aria-label={`剩余时间 ${clockText}`}>{clockText}</div>
          <p className="timer-calibration">{viewModel.pending ? '等待同步 · ' : ''}{clockLabel}</p>
          <button
            className="text-link text-link--green timer-sync-action"
            type="button"
            disabled={manualBusy}
            onClick={async () => {
              if (manualBusy) return;
              setManualBusy(true);
              try { await onManualSync(); } finally { setManualBusy(false); }
            }}
          >{manualBusy ? '计时器同步中…' : '同步计时器'}</button>
          {reason && (underlyingState === 'paused' || underlyingState === 'pausing')
            ? <p className="timer-reason">暂停原因：{reason}</p>
            : null}
          <Progress
            value={progress}
            max={timer.plannedSeconds}
            label={`${PHASE_LABELS[timer.phase]}计时进度`}
          />
        </div>
      </div>
      {reconciliation ? <TimerReconciliation
        model={reconciliation}
        onAdopt={async () => {
          await queue.acknowledgeTimerIssue(reconciliation.operationId);
          onMessage('已采用服务器状态');
        }}
        onRetry={async () => {
          await queue.retryTimerOperation(reconciliation.operationId);
          onMessage(`已重新提交${reconciliation.attemptedAction}操作`);
        }}
        onSwitch={() => {
          if (viewModel.serverTimer)
            onTimerSwitch(viewModel.serverTimer.dailyTaskId);
        }}
      /> : <TimerControls
        state={underlyingState}
        onPause={(pauseReason) => queue.pauseTimer(timer.id, pauseReason)}
        onResume={() => queue.resumeTimer(timer.id)}
        onExit={(exitReason) => queue.exitTimer(timer.id, exitReason)}
      />}
    </div>
  </section>;
}
