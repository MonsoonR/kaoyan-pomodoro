import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import {
  AppRuntime,
  createBrowserRuntime,
  type RuntimeSnapshot,
} from './app-runtime';
import type { SyncStatusSnapshot } from '../sync/types';

const RuntimeContext = createContext<AppRuntime | null>(null);
let browserRuntime: AppRuntime | null = null;

function defaultRuntime(): AppRuntime {
  browserRuntime ??= createBrowserRuntime();
  return browserRuntime;
}

export function RuntimeProvider({
  children,
  runtime = defaultRuntime(),
}: {
  children: ReactNode;
  runtime?: AppRuntime;
}) {
  useEffect(() => runtime.acquire(), [runtime]);
  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('RuntimeProvider is required');
  return runtime;
}

export function useRuntimeSnapshot(): RuntimeSnapshot {
  const runtime = useRuntime();
  return useSyncExternalStore(
    (listener) => runtime.subscribe(listener),
    () => runtime.getSnapshot(),
    () => runtime.getSnapshot(),
  );
}

export function useSyncStatus(): SyncStatusSnapshot {
  const runtime = useRuntime();
  return useSyncExternalStore(
    (listener) => runtime.engine.status.subscribe(listener),
    () => runtime.engine.status.getSnapshot() as SyncStatusSnapshot,
    () => runtime.engine.status.getSnapshot() as SyncStatusSnapshot,
  );
}
