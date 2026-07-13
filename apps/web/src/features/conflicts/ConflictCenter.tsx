import type { Conflict, ConflictResolution } from '@kaoyan/contracts';
import { GitMerge, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components.jsx';
import { useRuntime, useRuntimeSnapshot } from '../../runtime/runtime-context';
import { cacheConflicts } from '../../sync/conflicts';
import { AuthRequiredError, SyncClientError } from '../../sync/errors';
import {
  buildResolutionRequest,
  resolutionOptionsFor,
} from './resolution-options';

const TYPE_LABELS = {
  delete_modify: '删除与修改冲突',
  complete_restore: '完成与恢复冲突',
  archive_add_today: '归档与加入今日冲突',
} as const;

function payloadSummary(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload);
  if (!entries.length) return '无字段内容';
  return entries.slice(0, 4).map(([key, value]) => {
    const labels: Record<string, string> = {
      title: '标题', subject: '科目', archived: '归档状态',
      status: '完成状态', date: '日期', operationType: '操作',
    };
    const shown = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '已变更';
    return `${labels[key] ?? key}：${shown}`;
  }).join('；');
}

export function ConflictCenter({ conflicts }: { conflicts: Conflict[] }) {
  const runtime = useRuntime();
  const { activeUserId } = useRuntimeSnapshot();
  const [selected, setSelected] = useState<Conflict | null>(null);
  const [resolution, setResolution] = useState<ConflictResolution | null>(null);
  const [copyEntityId, setCopyEntityId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const openCount = conflicts.filter((conflict) => conflict.status === 'open').length;
  const options = useMemo(
    () => selected ? resolutionOptionsFor(selected.conflictType) : [],
    [selected],
  );
  useEffect(() => {
    if (!selected) return;
    setResolution(null);
    setCopyEntityId(crypto.randomUUID());
    setError('');
  }, [selected?.id]);

  const resolve = async () => {
    if (!selected || !resolution || !activeUserId || busy) return;
    setBusy(true);
    setError('');
    try {
      const request = resolution === 'copyAsNew'
        ? buildResolutionRequest(resolution, () => copyEntityId)
        : buildResolutionRequest(resolution, () => crypto.randomUUID());
      const response = await runtime.api.resolveConflict(selected.id, request);
      await cacheConflicts(
        runtime.database,
        activeUserId,
        [response.conflict],
        new Date().toISOString(),
      );
      await runtime.manualSync();
      setSelected(null);
      setNotice('冲突已解决，正在获取服务器最终结果。');
    } catch (reason) {
      if (reason instanceof AuthRequiredError) {
        await runtime.authenticationRequired();
        setError('会话已失效，请重新登录后继续解决冲突。');
      } else
      if (reason instanceof SyncClientError && reason.code === 'CONFLICT_ALREADY_RESOLVED')
        setError('这个冲突已在其他设备用不同方式解决，请先同步最新状态。');
      else if (reason instanceof SyncClientError)
        setError(reason.message);
      else setError('解决冲突失败，对话框已保留，请重试。');
    } finally { setBusy(false); }
  };

  return (
    <section className="settings-card settings-card--wide conflict-center">
      <div className="settings-card__title">
        <div><h2>同步冲突</h2><p>{openCount} 项需要确认；已解决记录也会保留。</p></div>
        <GitMerge />
      </div>
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {conflicts.length ? <div className="conflict-list">
        {conflicts.map((conflict) => (
          <article className="conflict-row" key={conflict.id}>
            <ShieldAlert size={20} />
            <div>
              <strong>{TYPE_LABELS[conflict.conflictType]}</strong>
              <span>{conflict.entityType} · {conflict.entityId}</span>
              <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(conflict.createdAt))}</small>
              <p>本地：{payloadSummary(conflict.localPayload)}</p>
              <p>服务器：{payloadSummary(conflict.serverPayload)}</p>
              {conflict.status === 'resolved' ? <span className="status status--done">已解决：{conflict.resolution}</span> : null}
            </div>
            {conflict.status === 'open' ? <button className="button button--outline button--small" type="button" onClick={() => setSelected(conflict)}>查看并解决</button> : null}
          </article>
        ))}
      </div> : <p className="empty-copy">目前没有同步冲突。</p>}
      <Modal open={Boolean(selected)} title={selected ? TYPE_LABELS[selected.conflictType] : '解决冲突'} onClose={() => !busy && setSelected(null)} size="medium">
        {selected ? <>
          <p className="dialog-copy">请选择你希望保留的最终状态。服务器会执行选择，随后应用会拉取权威结果。</p>
          <div className="conflict-comparison">
            <div><strong>本地操作</strong><p>{payloadSummary(selected.localPayload)}</p></div>
            <div><strong>服务器当前值</strong><p>{payloadSummary(selected.serverPayload)}</p></div>
          </div>
          <fieldset className="resolution-list">
            <legend>解决方式</legend>
            {options.map((option) => <label className={resolution === option.value ? 'resolution resolution--selected' : 'resolution'} key={option.value}>
              <input type="radio" name="resolution" value={option.value} checked={resolution === option.value} onChange={() => setResolution(option.value)} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>)}
          </fieldset>
          <details className="technical-details"><summary>技术详情</summary><pre>{JSON.stringify({
            conflictId: selected.id,
            localOperationId: selected.localOperationId,
            baseVersion: selected.baseVersion,
            serverVersion: selected.serverVersion,
          }, null, 2)}</pre></details>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="form-actions">
            <button className="button button--ghost" type="button" onClick={() => setSelected(null)} disabled={busy}>取消</button>
            <button className="button button--primary" type="button" onClick={resolve} disabled={!resolution || busy}>{busy ? '正在处理…' : '确认解决'}</button>
          </div>
        </> : null}
      </Modal>
    </section>
  );
}
