import { AlertCircle, LogIn, Sprout } from 'lucide-react';
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
        <small>仅支持已有账号登录，不提供网页注册或密码找回。</small>
      </section>
    </main>
  );
}

export function AuthExperience({ children }: { children: ReactNode }) {
  const snapshot = useRuntimeSnapshot();
  if (snapshot.authMode === 'booting')
    return <main className="login-page"><p role="status">正在打开本地学习空间…</p></main>;
  if (snapshot.authMode === 'login' && !snapshot.activeUserId)
    return <LoginScreen />;
  return (
    <>
      {children}
      <Modal
        open={snapshot.authMode === 'authRequired'}
        title="需要重新登录"
        onClose={() => undefined}
        dismissible={false}
        size="small"
      >
        <p className="dialog-copy">
          会话已失效。本机副本和待同步操作仍然保留，重新登录后会继续使用原操作编号上传。
        </p>
        <LoginForm reauthentication />
      </Modal>
    </>
  );
}
