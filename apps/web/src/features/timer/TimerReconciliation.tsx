import { AlertTriangle } from 'lucide-react';
import type { TimerReconciliationModel } from './timer-view-model';

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
    <div className="timer-reconciliation__actions">
      <button className="button button--primary" type="button" onClick={() => void onAdopt()}>
        采用服务器状态
      </button>
      {model.canRetry ? <button className="button button--outline" type="button" onClick={() => void onRetry()}>
        重新执行{model.attemptedAction}
      </button> : null}
      {model.canSwitchToTimer ? <button className="button button--outline" type="button" onClick={() => void onSwitch()}>
        切换到当前计时器
      </button> : null}
    </div>
  </section>;
}
