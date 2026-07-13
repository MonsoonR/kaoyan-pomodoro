import { Pause, Play, Square } from 'lucide-react';
import { useState } from 'react';
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
  starting: '正在开始，等待同步',
  pausing: '正在暂停，等待同步',
  resuming: '正在继续，等待同步',
  completing: '正在确认完成，等待同步',
  exiting: '正在退出，等待同步',
};

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
  const pendingLabel = PENDING_LABELS[state];
  const submitExit = async (event: React.FormEvent) => {
    event.preventDefault();
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
    await onExit(reason);
    setExitOpen(false);
  };

  if (pendingLabel) {
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
        onClick={() => void onPause('手动暂停')}
      ><Pause size={18} />暂停</button> : null}
      {state === 'paused' ? <button
        className="button button--primary button--large"
        type="button"
        aria-label="继续计时器"
        onClick={() => void onResume()}
      ><Play size={18} />继续</button> : null}
      {(state === 'running' || state === 'paused') ? <button
        className="button button--danger-ghost button--large"
        type="button"
        aria-label="提前退出计时器"
        onClick={() => setExitOpen(true)}
      ><Square size={17} />提前退出</button> : null}
    </div>
    <Modal open={exitOpen} title="提前退出" onClose={() => setExitOpen(false)}>
      <form onSubmit={submitExit}>
        <p className="dialog-copy">选择退出原因。服务器会生成一条中断的专注记录。</p>
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
            onChange={(event) => { setCustomReason(event.target.value); setError(''); }}
          />
        </label> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="form-actions">
          <button className="button button--ghost" type="button" onClick={() => setExitOpen(false)}>取消</button>
          <button className="button button--danger-ghost" type="submit">确认退出</button>
        </div>
      </form>
    </Modal>
  </>;
}
