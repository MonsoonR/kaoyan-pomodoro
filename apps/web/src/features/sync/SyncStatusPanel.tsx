import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
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
  offline: '暂时无法同步',
  authRequired: '需要重新登录',
  error: '暂时无法同步',
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
    () => `${label}，${pendingCount} 项学习记录等待更新`,
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
        <span className="sync-status__copy">
          <span>同步状态</span>
          <small>{label}</small>
        </span>
        {pendingCount > 0 ? <strong>{pendingCount}</strong> : null}
        <ChevronDown className="sync-status__chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="sync-popover">
        <p className="sr-only" aria-live="polite">{announcement}</p>
        <dl className="sync-counts">
          <div><dt>等待更新</dt><dd>{pendingCount}</dd></div>
          <div><dt>更新未完成</dt><dd>{rejectedCount}</dd></div>
          <div><dt>需要确认</dt><dd>{conflictCount}</dd></div>
        </dl>
        <p>
          最近更新：{status.lastSuccessfulSyncAt
            ? new Intl.DateTimeFormat('zh-CN', {
                dateStyle: 'short', timeStyle: 'medium',
              }).format(new Date(status.lastSuccessfulSyncAt))
            : '暂无记录'}
        </p>
        {status.lastErrorMessage ? (
          <p className="sync-error" role="status">数据暂时无法更新，请稍后重试。</p>
        ) : null}
        {status.phase === 'authRequired' ? (
          <p className="sync-hint">请重新登录。尚未更新的学习记录不会被删除。</p>
        ) : null}
        {syncIssues.length ? (
          <details className="sync-issues">
            <summary>查看 {syncIssues.length} 项数据问题</summary>
            <ul>{syncIssues.map((issue) => (
              <li key={issue.operationId}>这项学习记录暂时无法更新，请稍后重试。</li>
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
          {manualBusy ? '正在更新…' : '立即更新'}
        </button>
      </div>
    </details>
  );
}

export function MobileSyncNotice({
  rejectedCount,
  conflictCount,
  onViewIssues,
}: {
  rejectedCount: number;
  conflictCount: number;
  onViewIssues: () => void;
}) {
  const runtime = useRuntime();
  const status = useSyncStatus();
  const [manualBusy, setManualBusy] = useState(false);
  const manualSync = async () => {
    if (manualBusy || status.phase === 'syncing') return;
    setManualBusy(true);
    try { await runtime.manualSync(); } finally { setManualBusy(false); }
  };

  const notice = conflictCount > 0
    ? {
        kind: 'conflict',
        title: '有记录需要确认',
        description: `${conflictCount} 项学习记录需要查看`,
        action: '查看',
      }
    : status.phase === 'offline'
      ? {
          kind: 'offline',
          title: '网络不可用',
          description: '恢复连接后会继续同步',
          action: '重试',
        }
      : status.phase === 'authRequired'
        ? {
            kind: 'error',
            title: '同步需要重新登录',
            description: '学习记录已保留',
            action: '查看',
          }
        : status.phase === 'error' || rejectedCount > 0
          ? {
              kind: 'error',
              title: '同步暂时失败',
              description: '学习记录已保留，请稍后重试',
              action: '重试',
            }
          : null;

  if (!notice) return null;
  const retry = notice.action === '重试';
  return <div className={`mobile-sync mobile-sync-alert mobile-sync-alert--${notice.kind}`} role="status" aria-live="polite">
    {notice.kind === 'offline'
      ? <CloudOff size={16} />
      : notice.kind === 'conflict'
        ? <ShieldAlert size={16} />
        : <AlertCircle size={16} />}
    <span><strong>{notice.title}</strong><small>{notice.description}</small></span>
    <button className="text-link text-link--green" type="button" onClick={retry ? () => void manualSync() : onViewIssues} disabled={manualBusy}>
      {manualBusy ? '正在重试…' : notice.action}
    </button>
  </div>;
}
