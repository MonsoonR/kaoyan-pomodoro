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
  delete_modify: '任务的删除与修改存在差异',
  complete_restore: '任务的完成状态存在差异',
  archive_add_today: '任务的归档状态存在差异',
} as const;

function payloadSummary(payload: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    title: '标题', subject: '科目', archived: '归档状态',
    status: '完成状态', date: '日期',
  };
  const subjects: Record<string, string> = {
    math: '数学', english: '英语', politics: '政治', '408': '408', other: '其他',
  };
  const statuses: Record<string, string> = {
    pending: '待完成', completed: '已完成', awaiting_confirmation: '待确认',
  };
  const entries = Object.entries(payload).filter(([key]) => key in labels);
  if (!entries.length) return '内容已发生变化';
  return entries.slice(0, 4).map(([key, value]) => {
    const shown = key === 'subject' && typeof value === 'string'
      ? subjects[value] ?? '其他'
      : key === 'status' && typeof value === 'string'
        ? statuses[value] ?? '已变化'
        : key === 'archived' && typeof value === 'boolean'
          ? value ? '已归档' : '未归档'
          : typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : '已变化';
    return `${labels[key]}：${shown}`;
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
      setNotice('数据已处理，正在更新学习记录。');
    } catch (reason) {
      if (reason instanceof AuthRequiredError) {
        await runtime.authenticationRequired();
        setError('登录已过期，请重新登录后继续处理。');
      } else
      if (reason instanceof SyncClientError && reason.code === 'CONFLICT_ALREADY_RESOLVED')
        setError('这项数据已在其他设备处理，请先更新后再查看。');
      else if (reason instanceof SyncClientError)
        setError('暂时无法处理这项数据，请稍后重试。');
      else setError('暂时无法处理这项数据，请稍后重试。');
    } finally { setBusy(false); }
  };

  return (
    <section className="settings-section conflict-center">
      <div className="settings-card__title">
        <div><h2>数据需要处理</h2><p>{openCount ? `${openCount} 项学习记录需要确认。` : '所有学习记录状态一致。'}</p></div>
        <GitMerge />
      </div>
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {conflicts.length ? <div className="conflict-list">
        {conflicts.map((conflict) => (
          <article className="conflict-row" key={conflict.id}>
            <ShieldAlert size={20} />
            <div>
              <strong>{TYPE_LABELS[conflict.conflictType]}</strong>
              <small>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(conflict.createdAt))}</small>
              <p>这台设备：{payloadSummary(conflict.localPayload)}</p>
              <p>另一台设备：{payloadSummary(conflict.serverPayload)}</p>
              {conflict.status === 'resolved' ? <span className="status status--done">已处理</span> : null}
            </div>
            {conflict.status === 'open' ? <button className="button button--outline button--small" type="button" onClick={() => setSelected(conflict)}>查看并解决</button> : null}
          </article>
        ))}
      </div> : <p className="empty-copy">当前没有需要处理的数据。</p>}
      <Modal open={Boolean(selected)} title={selected ? TYPE_LABELS[selected.conflictType] : '处理数据差异'} onClose={() => !busy && setSelected(null)} size="medium">
        {selected ? <>
          <p className="dialog-copy">部分学习记录存在差异，请选择需要保留的内容。</p>
          <div className="conflict-comparison">
            <div><strong>这台设备</strong><p>{payloadSummary(selected.localPayload)}</p></div>
            <div><strong>另一台设备</strong><p>{payloadSummary(selected.serverPayload)}</p></div>
          </div>
          <fieldset className="resolution-list">
            <legend>选择保留方式</legend>
            {options.map((option) => <label className={resolution === option.value ? 'resolution resolution--selected' : 'resolution'} key={option.value}>
              <input type="radio" name="resolution" value={option.value} checked={resolution === option.value} onChange={() => setResolution(option.value)} />
              <span><strong>{option.label}</strong><small>{option.description}</small></span>
            </label>)}
          </fieldset>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="form-actions">
            <button className="button button--ghost" type="button" onClick={() => setSelected(null)} disabled={busy}>取消</button>
            <button className="button button--primary" type="button" onClick={resolve} disabled={!resolution || busy}>{busy ? '正在处理…' : '确认保留'}</button>
          </div>
        </> : null}
      </Modal>
    </section>
  );
}
