import { AlertCircle, LogIn, Sprout, UserPlus } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Modal } from '../../components.jsx';
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
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand"><Sprout /><span>考研番茄钟</span></div>
        <h1 id="login-title">登录你的学习空间</h1>
        <p>任务、今日计划、设置和专注记录会在同一账号的设备间同步。</p>
        {firstLoginOffline ? (
          <p className="login-offline" role="status">
            <AlertCircle size={18} /> 当前离线，首次使用需要联网登录。
          </p>
        ) : null}
        <LoginForm />
        <small>新账号需要管理员发送邀请链接，暂不提供密码找回。</small>
      </section>
    </main>
  );
}

function inviteTokenFromHash(): string | null {
  const match = globalThis.location?.hash.match(/^#\/invite\/([^/]+)$/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]!); } catch { return null; }
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
  return <main className="login-page">
    <section className="login-card" aria-labelledby="register-title">
      <div className="login-brand"><Sprout /><span>考研番茄钟</span></div>
      <h1 id="register-title">创建你的学习空间</h1>
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
  </main>;
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
  const inviteToken = inviteTokenFromHash();
  if (snapshot.authMode === 'booting')
    return <main className="login-page"><p role="status">正在打开本地学习空间…</p></main>;
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
