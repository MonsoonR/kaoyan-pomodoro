import {
  AlertCircle,
  CheckCircle2,
  CloudOff,
  RefreshCcw,
  ShieldAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { SyncIssueRow } from '../../db/types';
import { useRuntime, useSyncStatus } from '../../runtime/runtime-context';

const LABELS = {
  idle: '准备同步',
  syncing: '正在同步',
  synced: '已同步',
  offline: '离线使用',
  authRequired: '需要重新登录',
  error: '同步失败',
} as const;

function StatusIcon({ phase }: { phase: keyof typeof LABELS }) {
  if (phase === 'synced') return <CheckCircle2 size={16} />;
  if (phase === 'offline') return <CloudOff size={16} />;
  if (phase === 'authRequired') return <ShieldAlert size={16} />;
  if (phase === 'error') return <AlertCircle size={16} />;
  return <RefreshCcw size={16} className={phase === 'syncing' ? 'spin' : ''} />;
}

export function SyncStatusPanel({
  pendingCount,
  rejectedCount,
  conflictCount,
  syncIssues,
}: {
  pendingCount: number;
  rejectedCount: number;
  conflictCount: number;
  syncIssues: SyncIssueRow[];
}) {
  const runtime = useRuntime();
  const status = useSyncStatus();
  const [manualBusy, setManualBusy] = useState(false);
  const label = LABELS[status.phase];
  const announcement = useMemo(
    () => `${label}，${pendingCount} 项待同步`,
    [label, pendingCount],
  );
  const manualSync = async () => {
    if (manualBusy || status.phase === 'syncing') return;
    setManualBusy(true);
    try { await runtime.manualSync(); } finally { setManualBusy(false); }
  };
  return (
    <details className={`sync-status sync-status--${status.phase}`}>
      <summary>
        <StatusIcon phase={status.phase} />
        <span>{label}</span>
        {pendingCount > 0 ? <strong>{pendingCount}</strong> : null}
      </summary>
      <div className="sync-popover">
        <p className="sr-only" aria-live="polite">{announcement}</p>
        <dl className="sync-counts">
          <div><dt>待同步</dt><dd>{pendingCount}</dd></div>
          <div><dt>被拒绝</dt><dd>{rejectedCount}</dd></div>
          <div><dt>待处理冲突</dt><dd>{conflictCount}</dd></div>
        </dl>
        <p>
          最后成功同步：{status.lastSuccessfulSyncAt
            ? new Intl.DateTimeFormat('zh-CN', {
                dateStyle: 'short', timeStyle: 'medium',
              }).format(new Date(status.lastSuccessfulSyncAt))
            : '尚未完成'}
        </p>
        {status.lastErrorMessage ? (
          <p className="sync-error" role="status">最近错误：{status.lastErrorMessage}</p>
        ) : null}
        {status.phase === 'authRequired' ? (
          <p className="sync-hint">请重新登录。不要清空本地数据，待同步工作仍保留在本机。</p>
        ) : null}
        {syncIssues.length ? (
          <details className="sync-issues">
            <summary>查看 {syncIssues.length} 项同步问题</summary>
            <ul>{syncIssues.map((issue) => (
              <li key={issue.operationId}>{issue.errorMessage}</li>
            ))}</ul>
          </details>
        ) : null}
        <button
          className="button button--outline button--small"
          type="button"
          onClick={manualSync}
          disabled={manualBusy || status.phase === 'syncing' || status.phase === 'authRequired'}
        >
          <RefreshCcw size={15} className={manualBusy ? 'spin' : ''} />
          {manualBusy ? '同步中…' : '立即同步'}
        </button>
      </div>
    </details>
  );
}
