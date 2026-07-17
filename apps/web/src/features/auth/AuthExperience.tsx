import { AlertCircle, LogIn, UserPlus } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Modal } from '../../components.jsx';
import { Brand } from '../../components/Brand';
import { NetworkError, RateLimitedError, ServerError, SyncClientError } from '../../sync/errors';
import { useRuntime, useRuntimeSnapshot } from '../../runtime/runtime-context';

function loginMessage(error: unknown): string {
  if (error instanceof RateLimitedError)
    return '登录尝试过于频繁，请稍后再试。';
  if (error instanceof NetworkError)
    return '网络连接失败，当前无法登录。';
  if (error instanceof ServerError)
    return '服务器暂时不可用，请稍后再试。';
  if (error instanceof SyncClientError && error.code === 'INVALID_CREDENTIALS')
    return '用户名或密码错误。';
  if (error instanceof SyncClientError && error.code === 'AUTH_FAILED')
    return '用户名或密码错误。';
  return '登录失败，请检查用户名和密码后重试。';
}

export function LoginForm({ reauthentication = false }: {
  reauthentication?: boolean;
}) {
  const runtime = useRuntime();
  const snapshot = useRuntimeSnapshot();
  const [username, setUsername] = useState(snapshot.username ?? '');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await runtime.login(username, password);
      setPassword('');
    } catch (reason) {
      setError(loginMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form className="login-form" onSubmit={submit} aria-describedby={error ? errorId : undefined}>
      <label className="field field--full">
        <span>用户名</span>
        <input
          autoComplete="username"
          autoFocus
          minLength={3}
          maxLength={64}
          required
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="field field--full">
        <span>{reauthentication ? '再次输入密码' : '密码'}</span>
        <input
          type="password"
          autoComplete="current-password"
          minLength={12}
          maxLength={128}
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error ? <p id={errorId} className="form-error" role="alert">{error}</p> : null}
      <button className="button button--primary button--wide" type="submit" disabled={submitting}>
        <LogIn size={18} />
        {submitting ? '正在登录…' : reauthentication ? '重新登录并继续同步' : '登录'}
      </button>
    </form>
  );
}

function LoginScreen() {
  const { firstLoginOffline } = useRuntimeSnapshot();
  return (
    <AuthScaffold>
      <section className="login-card" aria-labelledby="login-title">
        <p className="login-kicker">考研番茄钟 / STUDY WITH RHYTHM</p>
        <h1 id="login-title">把今天的每一段，<br />交给专注。</h1>
        <p>任务、今日计划、设置和专注记录，会在同一账号的设备间安全同步。</p>
        {firstLoginOffline ? (
          <p className="login-offline" role="status">
            <AlertCircle size={18} /> 当前离线，首次使用需要联网登录。
          </p>
        ) : null}
        <LoginForm />
        <p className="login-privacy">每个账号的数据彼此隔离；同步内容只对当前账号已登录的设备可见。</p>
        <InviteEntry />
      </section>
    </AuthScaffold>
  );
}

function AuthScaffold({ children }: { children: ReactNode }) {
  return <main className="login-page">
    <section className="login-art" aria-hidden="true">
      <Brand inverse />
      <div className="login-art__orbit"><span>25:00</span></div>
      <blockquote>不是冲刺的喧闹，<br />是每天都能抵达的一小段。</blockquote>
      <small>FOCUS · REST · RETURN</small>
    </section>
    <section className="login-panel">{children}</section>
  </main>;
}

function inviteTokenFromHash(hash = globalThis.location?.hash ?? ''): string | null {
  const match = hash.match(/^#\/invite\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
}

function inviteTokenFromInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hashMatch = trimmed.match(/#\/invite\/([^/?#]+)/);
  const encodedToken = hashMatch?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : null);
  if (!encodedToken) return null;
  try { return decodeURIComponent(encodedToken); } catch { return null; }
}

function InviteEntry() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const token = inviteTokenFromInput(value);
    if (!token) {
      setError('请输入管理员发来的完整邀请链接或邀请码。');
      return;
    }
    setOpen(false);
    window.location.hash = `#/invite/${encodeURIComponent(token)}`;
  };
  return <div className="login-secondary">
    <button className="text-link text-link--green" type="button" onClick={() => { setError(''); setOpen(true); }}>使用邀请码注册</button>
    <small>注册需要管理员发出的有效邀请，暂不提供密码找回。</small>
    <Modal open={open} title="使用邀请码注册" size="small" onClose={() => setOpen(false)}>
      <form className="login-form" onSubmit={submit}>
        <p className="dialog-copy">粘贴管理员发来的完整邀请链接，或直接输入邀请码。</p>
        <label className="field field--full"><span>邀请链接或邀请码</span><input autoFocus autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button button--primary button--wide" type="submit"><UserPlus size={18} />继续注册</button>
      </form>
    </Modal>
  </div>;
}

function registrationMessage(error: unknown): string {
  if (error instanceof SyncClientError) {
    const messages: Record<string, string> = {
      INVITE_NOT_FOUND: '这个邀请链接无效。',
      INVITE_USED: '这个邀请已经使用过了。',
      INVITE_REVOKED: '这个邀请已被撤销。',
      INVITE_EXPIRED: '这个邀请已过期。',
      USERNAME_EXISTS: '这个用户名已经有人使用。',
      PASSWORD_REQUIREMENTS: '密码至少需要 12 个字符，两次输入必须一致。',
      VALIDATION_ERROR: '请检查用户名和密码是否符合要求。',
    };
    return messages[error.code] ?? '注册失败，请稍后再试。';
  }
  if (error instanceof RateLimitedError) return '尝试次数过多，请稍后再试。';
  if (error instanceof NetworkError) return '网络连接失败，请联网后重试。';
  return '注册失败，请稍后再试。';
}

function InviteRegistrationScreen({ token }: { token: string }) {
  const runtime = useRuntime();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await runtime.registerWithInvite(
        token,
        username,
        password,
        confirmPassword,
      );
      window.location.hash = '#/home';
    } catch (reason) {
      setError(registrationMessage(reason));
    } finally { setSubmitting(false); }
  };
  return <AuthScaffold>
    <section className="login-card" aria-labelledby="register-title">
      <p className="login-kicker">仅限受邀注册</p>
      <h1 id="register-title">用一枚邀请，<br />开启备考节奏。</h1>
      <p>设置登录信息后，就可以开始安排自己的复习任务。</p>
      <form className="login-form" onSubmit={submit}>
        <label className="field field--full"><span>用户名</span><input autoFocus required minLength={3} maxLength={64} autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="field field--full"><span>密码</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small>至少 12 个字符</small></label>
        <label className="field field--full"><span>再次输入密码</span><input type="password" required minLength={12} maxLength={128} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="button button--primary button--wide" type="submit" disabled={submitting}><UserPlus size={18} />{submitting ? '正在创建…' : '完成注册'}</button>
      </form>
      <button className="text-link" type="button" onClick={() => { window.location.hash = '#/home'; }}>返回登录</button>
    </section>
  </AuthScaffold>;
}

function RequiredPasswordChange() {
  const runtime = useRuntime();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await runtime.changePassword(currentPassword, newPassword, confirmPassword);
    } catch { setError('密码修改失败，请检查当前密码和新密码。'); }
    finally { setBusy(false); }
  };
  return <Modal open title="请先修改密码" dismissible={false} onClose={() => undefined} size="small">
    <form className="login-form" onSubmit={submit}>
      <p className="dialog-copy">管理员为你重置了密码。继续使用前，请设置一个只有你知道的新密码。</p>
      <label className="field field--full"><span>当前密码</span><input type="password" required minLength={12} autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label className="field field--full"><span>新密码</span><input type="password" required minLength={12} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label className="field field--full"><span>再次输入新密码</span><input type="password" required minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button>
    </form>
  </Modal>;
}

export function AuthExperience({ children }: { children: ReactNode }) {
  const snapshot = useRuntimeSnapshot();
  const [locationHash, setLocationHash] = useState(() => globalThis.location?.hash ?? '');
  useEffect(() => {
    const update = () => setLocationHash(globalThis.location?.hash ?? '');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const inviteToken = inviteTokenFromHash(locationHash);
  if (snapshot.authMode === 'booting')
    return <main className="login-page login-page--loading"><p role="status">正在打开本地学习空间…</p></main>;
  if (snapshot.authMode === 'login' && !snapshot.activeUserId)
    return inviteToken ? <InviteRegistrationScreen token={inviteToken} /> : <LoginScreen />;
  return (
    <>
      {children}
      {snapshot.session?.user.mustChangePassword ? <RequiredPasswordChange /> : null}
      <Modal
        open={snapshot.authMode === 'authRequired'}
        title="需要重新登录"
        onClose={() => undefined}
        dismissible={false}
        size="small"
      >
        <p className="dialog-copy">
          登录已过期。你的学习记录和刚才的修改都已保留，重新登录后会自动同步。
        </p>
        <LoginForm reauthentication />
      </Modal>
    </>
  );
}
