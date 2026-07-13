import { ChangePasswordRequestSchema, type Device } from '@kaoyan/contracts';
import { KeyRound, Laptop, LogOut, Pencil, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useRuntime, useRuntimeSnapshot } from '../../runtime/runtime-context';
import { AuthRequiredError, SyncClientError } from '../../sync/errors';

function readableError(error: unknown): string {
  if (error instanceof SyncClientError) {
    if (error.code === 'INVALID_CURRENT_PASSWORD') return '当前密码不正确。';
    if (error.code === 'CURRENT_DEVICE') return '当前设备请使用“退出当前设备”。';
    if (error.code === 'NETWORK_ERROR') return '网络连接失败，已保留当前设备列表。';
    return error.message;
  }
  return '操作失败，请稍后重试。';
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

export function AccountPanel() {
  const runtime = useRuntime();
  const { session, username, authMode } = useRuntimeSnapshot();
  const [devices, setDevices] = useState<readonly Device[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);
  const statusId = useId();
  const reportError = (reason: unknown) => {
    if (reason instanceof AuthRequiredError ||
      (reason instanceof SyncClientError && reason.code === 'AUTH_REQUIRED'))
      void runtime.authenticationRequired();
    setError(readableError(reason));
  };

  const refresh = useCallback(async () => {
    if (authMode !== 'authenticated') return;
    setLoading(true);
    setError('');
    try {
      setDevices(await runtime.api.listDevices());
    } catch (reason) {
      reportError(reason);
    } finally {
      setLoading(false);
    }
  }, [authMode, runtime]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveName = async (event: FormEvent, deviceId: string) => {
    event.preventDefault();
    setError('');
    try {
      await runtime.api.renameDevice(deviceId, deviceName);
      setRenaming(null);
      setNotice('设备名称已更新。');
      await refresh();
    } catch (reason) { reportError(reason); }
  };

  const revoke = async (device: Device) => {
    if (device.isCurrent) return;
    if (!window.confirm(`确定退出设备“${device.name}”吗？`)) return;
    setError('');
    try {
      await runtime.api.revokeDevice(device.id);
      setNotice('设备已退出。');
      await refresh();
    } catch (reason) { reportError(reason); }
  };

  const logoutOthers = async () => {
    if (!window.confirm('确定退出除当前设备外的所有设备吗？')) return;
    setError('');
    try {
      await runtime.api.logoutOtherDevices();
      setNotice('其他设备已全部退出。');
      await refresh();
    } catch (reason) { reportError(reason); }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    const parsed = ChangePasswordRequestSchema.safeParse({
      currentPassword: passwords.current,
      newPassword: passwords.next,
      confirmPassword: passwords.confirm,
    });
    if (!parsed.success) {
      setError(passwords.next !== passwords.confirm
        ? '两次输入的新密码不一致。'
        : '密码长度需为 12–128 个字符。');
      return;
    }
    setPasswordBusy(true);
    try {
      await runtime.api.changePassword(
        passwords.current,
        passwords.next,
        passwords.confirm,
      );
      setPasswords({ current: '', next: '', confirm: '' });
      setNotice('密码已修改，其他设备的会话已失效。');
      await refresh();
    } catch (reason) { reportError(reason); }
    finally { setPasswordBusy(false); }
  };

  return (
    <section className="settings-card settings-card--wide account-panel" aria-describedby={statusId}>
      <div className="settings-card__title">
        <div><h2>账号与设备</h2><p>账号：{username ?? '本机用户'}</p></div>
        <ShieldCheck />
      </div>
      <div id={statusId} aria-live="polite">
        {notice ? <p className="form-success" role="status">{notice}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      {session ? (
        <p className="account-session">
          当前设备：<strong>{session.deviceName}</strong> · 会话到期 {formatTime(session.expiresAt)}
        </p>
      ) : (
        <p className="account-session">离线使用中，联网并重新验证会话后可刷新设备列表。</p>
      )}
      <div className="device-list" aria-busy={loading}>
        {devices.map((device) => (
          <article className="device-row" key={device.id}>
            <Laptop size={20} />
            <div className="device-row__main">
              {renaming === device.id ? (
                <form className="inline-form" onSubmit={(event) => saveName(event, device.id)}>
                  <label className="field"><span>设备名称</span><input
                    autoFocus maxLength={100} required value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                  /></label>
                  <button className="button button--primary button--small" type="submit">保存</button>
                  <button className="button button--ghost button--small" type="button" onClick={() => setRenaming(null)}>取消</button>
                </form>
              ) : (
                <><strong>{device.name}{device.isCurrent ? '（当前设备）' : ''}</strong>
                  <span>{device.browser} · {device.operatingSystem}</span>
                  <small>首次登录 {formatTime(device.firstLoginAt)} · 最近活跃 {formatTime(device.lastActiveAt)}</small></>
              )}
            </div>
            {renaming !== device.id ? <div className="device-row__actions">
              <button className="icon-button" type="button" aria-label={`重命名：${device.name}`} onClick={() => { setRenaming(device.id); setDeviceName(device.name); }}><Pencil size={16} /></button>
              {!device.isCurrent ? <button className="button button--danger-ghost button--small" type="button" onClick={() => revoke(device)}>退出设备</button> : null}
            </div> : null}
          </article>
        ))}
        {loading ? <p role="status">正在刷新设备…</p> : null}
      </div>
      <div className="account-actions">
        <button className="button button--outline" type="button" onClick={logoutOthers} disabled={authMode !== 'authenticated'}>退出其他所有设备</button>
        <button className="button button--danger-ghost" type="button" onClick={() => void runtime.logout()}><LogOut size={17} />退出当前设备</button>
      </div>
      <form className="password-form" onSubmit={changePassword}>
        <div className="settings-card__title"><div><h3>修改密码</h3><p>修改后当前设备继续登录，其他设备需要重新认证。</p></div><KeyRound /></div>
        <div className="form-grid">
          <label className="field"><span>当前密码</span><input type="password" autoComplete="current-password" minLength={12} maxLength={128} required value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} /></label>
          <label className="field"><span>新密码</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} /></label>
          <label className="field"><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} /></label>
        </div>
        <button className="button button--primary" type="submit" disabled={passwordBusy}>{passwordBusy ? '正在修改…' : '修改密码'}</button>
      </form>
    </section>
  );
}
