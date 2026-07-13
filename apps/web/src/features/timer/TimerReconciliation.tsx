import { AlertTriangle } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TimerReconciliationModel } from './timer-view-model';

type ReconciliationBusy = 'adopt' | 'retry' | 'switch';

const BUSY_LABELS: Record<ReconciliationBusy, string> = {
  adopt: '正在采用服务器状态…',
  retry: '正在重新执行操作…',
  switch: '正在切换到当前计时器…',
};

export function TimerReconciliation({
  model,
  onAdopt,
  onRetry,
  onSwitch,
}: {
  model: TimerReconciliationModel;
  onAdopt: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
  onSwitch: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<ReconciliationBusy | null>(null);
  const [error, setError] = useState('');
  const [retrySubmitted, setRetrySubmitted] = useState(false);
  const [adoptSubmitted, setAdoptSubmitted] = useState(false);
  const busyRef = useRef<ReconciliationBusy | null>(null);
  const retrySubmittedRef = useRef(false);
  const adoptSubmittedRef = useRef(false);
  const mountedRef = useRef(false);
  const actionGenerationRef = useRef(0);
  const operationIdRef = useRef(model.operationId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      actionGenerationRef.current += 1;
      busyRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    actionGenerationRef.current += 1;
    operationIdRef.current = model.operationId;
    busyRef.current = null;
    retrySubmittedRef.current = false;
    adoptSubmittedRef.current = false;
    setBusy(null);
    setError('');
    setRetrySubmitted(false);
    setAdoptSubmitted(false);
  }, [model.operationId]);

  const runAction = async (
    nextBusy: ReconciliationBusy,
    action: () => void | Promise<void>,
  ) => {
    if (busyRef.current ||
        (nextBusy === 'retry' && retrySubmittedRef.current) ||
        (nextBusy === 'adopt' && adoptSubmittedRef.current)) return;
    const generation = actionGenerationRef.current + 1;
    actionGenerationRef.current = generation;
    const operationId = model.operationId;
    busyRef.current = nextBusy;
    setBusy(nextBusy);
    setError('');
    try {
      await action();
    } catch (reason) {
      if (!mountedRef.current ||
          generation !== actionGenerationRef.current ||
          operationId !== operationIdRef.current) return;
      busyRef.current = null;
      setBusy(null);
      setError(reason instanceof Error
        ? reason.message
        : '计时器状态处理失败，请重试');
      return;
    }
    if (!mountedRef.current ||
        generation !== actionGenerationRef.current ||
        operationId !== operationIdRef.current) return;
    busyRef.current = null;
    setBusy(null);
    if (nextBusy === 'retry') {
      retrySubmittedRef.current = true;
      setRetrySubmitted(true);
    }
    if (nextBusy === 'adopt') {
      adoptSubmittedRef.current = true;
      setAdoptSubmitted(true);
    }
  };

  return <section className="timer-reconciliation" role="alert">
    <div className="timer-reconciliation__title">
      <AlertTriangle aria-hidden="true" />
      <div><h2>需要确认计时器状态</h2><p>{model.explanation}</p></div>
    </div>
    <dl>
      <div><dt>本机操作</dt><dd>尝试了“{model.attemptedAction}”（{new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(model.operationCreatedAt))}）</dd></div>
      <div><dt>服务器状态</dt><dd>{model.serverDescription}</dd></div>
      <div><dt>错误代码</dt><dd>{model.errorCode}</dd></div>
    </dl>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {busy ? <p role="status" className="sr-only">{BUSY_LABELS[busy]}</p> : null}
    <div className="timer-reconciliation__actions">
      <button className="button button--primary" type="button" disabled={busy !== null || adoptSubmitted} onClick={() => void runAction('adopt', onAdopt)}>
        {busy === 'adopt'
          ? '正在采用…'
          : adoptSubmitted
            ? '已采用，等待本地状态更新…'
            : '采用服务器状态'}
      </button>
      {model.canRetry ? <button className="button button--outline" type="button" disabled={busy !== null || retrySubmitted} onClick={() => void runAction('retry', onRetry)}>
        {busy === 'retry'
          ? '正在重新执行…'
          : retrySubmitted
            ? '已重新提交，等待同步'
            : `重新执行${model.attemptedAction}`}
      </button> : null}
      {model.canSwitchToTimer ? <button className="button button--outline" type="button" disabled={busy !== null} onClick={() => void runAction('switch', onSwitch)}>
        {busy === 'switch' ? '正在切换…' : '切换到当前计时器'}
      </button> : null}
    </div>
  </section>;
}
