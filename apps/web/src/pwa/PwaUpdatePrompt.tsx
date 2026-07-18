import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaUpdatePrompt() {
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError() {
      setError('暂时无法完成更新，稍后可以重试。');
    },
  });

  const update = async () => {
    setUpdating(true);
    setError(null);
    try {
      await updateServiceWorker(true);
    } catch {
      setError('暂时无法启用新内容，请稍后重试。');
      setUpdating(false);
    }
  };

  if (error) return <div className="pwa-notice pwa-notice--error" role="alert">
    <span>{error}</span><button type="button" onClick={() => setError(null)}>关闭</button>
  </div>;
  if (needRefresh && dismissed) return <button className="pwa-update-reopen" type="button" onClick={() => setDismissed(false)}>发现新内容</button>;
  if (needRefresh) return <div className="pwa-notice" role="status" aria-live="polite">
    <span>新内容已准备好。当前计时不会中断。</span>
    <button type="button" disabled={updating} onClick={() => void update()}>{updating ? '正在更新…' : '更新并刷新'}</button>
    <button type="button" disabled={updating} onClick={() => setDismissed(true)}>稍后</button>
  </div>;
  if (offlineReady) return <div className="pwa-notice" role="status">
    <span>应用已可离线打开。</span><button type="button" onClick={() => setOfflineReady(false)}>知道了</button>
  </div>;
  return null;
}
