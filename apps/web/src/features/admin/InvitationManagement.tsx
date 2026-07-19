import type { Invitation } from '@kaoyan/contracts';
import { Clipboard, Link2, Plus, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Modal } from '../../components.jsx';
import { AppSelect } from '../../components/AppSelect';
import { useRuntime } from '../../runtime/runtime-context';

const STATUS_LABELS: Record<Invitation['status'], string> = {
  active: '可使用',
  used: '已使用',
  expired: '已过期',
  revoked: '已撤销',
};

const EXPIRY_OPTIONS = [
  { value: 1, label: '1 小时' },
  { value: 24, label: '24 小时' },
  { value: 168, label: '7 天' },
  { value: 720, label: '30 天' },
] as const;

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function InvitationManagement() {
  const runtime = useRuntime();
  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = async () => {
    setError('');
    try { setInvitations(await runtime.api.listInvitations()); }
    catch { setError('暂时无法读取邀请记录，请稍后再试。'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await runtime.api.createInvitation(expiresInHours);
      setCreatedUrl(result.inviteUrl);
      setCopied(false);
      await refresh();
    } catch { setError('创建邀请失败，请稍后再试。'); }
    finally { setBusy(false); }
  };

  const revoke = async (invitation: Invitation) => {
    if (busy || !window.confirm('撤销这个邀请？撤销后将无法注册。')) return;
    setBusy(true);
    setError('');
    try {
      await runtime.api.revokeInvitation(invitation.id);
      await refresh();
    } catch { setError('撤销失败，邀请可能已经使用或过期。'); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
    } catch { setError('复制失败，请手动选择并复制链接。'); }
  };

  return <section className="page">
    <header className="page-header"><div><h1>邀请管理</h1><p>为新用户创建一次性注册链接。</p></div></header>
    <section className="panel invite-management">
      <section className="invite-section invite-create">
        <div className="section-title"><div><h2>创建邀请</h2><p>链接成功使用一次后会立即失效。</p></div><ShieldCheck /></div>
        <div className="invite-create__controls">
          <AppSelect label="有效期" value={expiresInHours} onChange={setExpiresInHours} options={EXPIRY_OPTIONS} />
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void create()}><Plus size={17} />{busy ? '正在创建…' : '创建邀请链接'}</button>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </section>
      <section className="invite-section">
        <div className="section-title"><div><h2>邀请记录</h2><p>{invitations.length} 条记录</p></div><Link2 /></div>
        {loading ? <p role="status">正在读取邀请记录…</p> : invitations.length ? <div className="invite-list">{invitations.map((invitation) => <article className="invite-row" key={invitation.id}>
          <div><span className={`status invite-status invite-status--${invitation.status}`}>{STATUS_LABELS[invitation.status]}</span><strong>创建于 {formatDate(invitation.createdAt)}</strong><small>有效期至 {formatDate(invitation.expiresAt)}</small>{invitation.usedBy ? <small>使用者：{invitation.usedBy.username}</small> : null}</div>
          {invitation.status === 'active' ? <button className="button button--danger-ghost button--small" type="button" disabled={busy} onClick={() => void revoke(invitation)}><XCircle size={15} />撤销</button> : null}
        </article>)}</div> : <p className="empty-copy">还没有创建过邀请。</p>}
      </section>
    </section>
    <Modal open={createdUrl !== null} title="邀请链接已创建" onClose={() => setCreatedUrl(null)} size="medium">
      <p className="dialog-copy">完整链接只会显示这一次，请立即复制并通过可信方式发送。</p>
      <div className="invite-link"><input readOnly aria-label="邀请链接" value={createdUrl ?? ''} /><button className="button button--primary" type="button" onClick={() => void copy()}><Clipboard size={16} />{copied ? '已复制' : '复制链接'}</button></div>
    </Modal>
  </section>;
}
