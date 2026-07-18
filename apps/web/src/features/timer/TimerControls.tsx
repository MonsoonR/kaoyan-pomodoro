import { Pause, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../../components.jsx';
import type { TimerViewState } from './timer-view-model';

const EXIT_REASONS = [
  '临时有事',
  '注意力分散',
  '任务已完成',
  '计划调整',
  '其他',
] as const;

const PENDING_LABELS: Partial<Record<TimerViewState, string>> = {
  starting: '正在开始…',
  pausing: '正在暂停…',
  resuming: '正在继续…',
  completing: '正在确认完成…',
  exiting: '正在退出…',
};

type LocalBusyState = 'pausing' | 'resuming' | 'exiting';

const LOCAL_BUSY_LABELS: Record<LocalBusyState, string> = {
  pausing: '正在暂停…',
  resuming: '正在继续…',
  exiting: '正在退出…',
};

function errorMessage(): string {
  return '计时操作暂时无法完成，请重试。';
}

export function TimerControls({
  state,
  onPause,
  onResume,
  onExit,
}: {
  state: TimerViewState;
  onPause: (reason: string) => void | Promise<unknown>;
  onResume: () => void | Promise<unknown>;
  onExit: (reason: string) => void | Promise<unknown>;
}) {
  const [exitOpen, setExitOpen] = useState(false);
  const [selectedReason, setSelectedReason] = useState<string>('临时有事');
  const [customReason, setCustomReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<LocalBusyState | null>(null);
  const busyRef = useRef<LocalBusyState | null>(null);
  const busyOriginRef = useRef<TimerViewState | null>(null);
  const busySettledRef = useRef(false);
  const stateRef = useRef(state);

  const clearBusy = () => {
    busyRef.current = null;
    busyOriginRef.current = null;
    busySettledRef.current = false;
    setBusy(null);
  };

  useEffect(() => {
    stateRef.current = state;
    if (busyRef.current && busySettledRef.current &&
        state !== busyOriginRef.current) clearBusy();
  }, [state]);

  const runControl = async (
    nextBusy: LocalBusyState,
    action: () => void | Promise<unknown>,
  ) => {
    if (busyRef.current) return;
    busyRef.current = nextBusy;
    busyOriginRef.current = stateRef.current;
    busySettledRef.current = false;
    setBusy(nextBusy);
    setError('');
    try {
      await action();
      busySettledRef.current = true;
      if (stateRef.current !== busyOriginRef.current) clearBusy();
    } catch {
      setError(errorMessage());
      clearBusy();
    }
  };

  const pendingLabel = PENDING_LABELS[state] ??
    (busy ? LOCAL_BUSY_LABELS[busy] : undefined);
  const submitExit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    const reason = selectedReason === '其他'
      ? customReason.trim()
      : selectedReason;
    if (!reason) {
      setError('请填写退出原因');
      return;
    }
    if (reason.length > 500) {
      setError('退出原因不能超过 500 个字符');
      return;
    }
    await runControl('exiting', async () => {
      await onExit(reason);
      setExitOpen(false);
    });
  };

  if (pendingLabel && !exitOpen) {
    return <div className="focus-actions">
      <button className="button button--primary button--large" type="button" disabled>
        {pendingLabel}
      </button>
      <span role="status" className="sr-only">{pendingLabel}</span>
    </div>;
  }

  return <>
    <div className="focus-actions">
      {state === 'running' ? <button
        className="button button--outline button--large"
        type="button"
        aria-label="暂停计时器"
        disabled={busy !== null}
        onClick={() => void runControl(
          'pausing', () => onPause('手动暂停'),
        )}
      ><Pause size={18} />暂停</button> : null}
      {state === 'paused' ? <button
        className="button button--primary button--large"
        type="button"
        aria-label="继续计时器"
        disabled={busy !== null}
        onClick={() => void runControl('resuming', onResume)}
      ><Play size={18} />继续</button> : null}
      {(state === 'running' || state === 'paused') ? <button
        className="button button--danger-ghost button--large"
        type="button"
        aria-label="提前退出计时器"
        disabled={busy !== null}
        onClick={() => setExitOpen(true)}
      ><Square size={17} />提前退出</button> : null}
      {busy ? <span role="status" className="sr-only">
        {LOCAL_BUSY_LABELS[busy]}
      </span> : null}
    </div>
    {!exitOpen && error ? <p className="form-error" role="alert">{error}</p> : null}
    <Modal
      open={exitOpen}
      title="提前退出"
      dismissible={busy === null}
      onClose={() => { if (!busyRef.current) setExitOpen(false); }}
    >
      <form onSubmit={submitExit}>
        <p className="dialog-copy">选择退出原因，退出后会保留这次专注记录。</p>
        <div className="reason-list">
          {EXIT_REASONS.map((reason) => <label
            className={selectedReason === reason ? 'reason reason--selected' : 'reason'}
            key={reason}
          >
            <input
              type="radio"
              name="exit-reason"
              value={reason}
              checked={selectedReason === reason}
              disabled={busy !== null}
              onChange={() => { setSelectedReason(reason); setError(''); }}
            />
            {reason}
          </label>)}
        </div>
        {selectedReason === '其他' ? <label className="field field--full">
          <span>自定义退出原因</span>
          <input
            value={customReason}
            maxLength={500}
            disabled={busy !== null}
            onChange={(event) => { setCustomReason(event.target.value); setError(''); }}
          />
        </label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button className="button button--ghost" type="button" disabled={busy !== null} onClick={() => setExitOpen(false)}>取消</button>
          <button className="button button--danger" type="submit" disabled={busy !== null}>
            {busy === 'exiting' ? '正在退出…' : '确认退出'}
          </button>
          {busy === 'exiting' ? <span role="status" className="sr-only">
            正在退出…
          </span> : null}
        </div>
      </form>
    </Modal>
  </>;
}
