import type { DailyTask, Settings, Task } from '@kaoyan/contracts';
import {
  Archive,
  ArrowRight,
  BookOpen,
  Clock3,
  Focus,
  Home,
  Library,
  ListTodo,
  MoreHorizontal,
  LogOut,
  Plus,
  Save,
  Settings as SettingsIcon,
  Sprout,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, SubjectBadge, TaskForm, TaskRow } from './components.jsx';
import { Brand } from './components/Brand';
import { getExamCountdown } from './config/exam-date';
import { AccountPanel } from './features/devices/AccountPanel';
import { AuthExperience } from './features/auth/AuthExperience';
import { ConflictCenter } from './features/conflicts/ConflictCenter';
import { FocusDashboard } from './features/dashboard/FocusDashboard';
import { useReplicaData } from './features/replicas/use-replica-data';
import { SyncStatusPanel } from './features/sync/SyncStatusPanel';
import { TimerPage } from './features/timer/TimerPage';
import { InvitationManagement } from './features/admin/InvitationManagement';
import { useTimerState } from './features/timer/use-timer-state';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  formatDuration,
  getDurations,
  getDateKey,
  getIsoDateKey,
  getSummary,
  validateTaskInput,
} from './model.js';
import { RuntimeProvider, useRuntime, useRuntimeSnapshot } from './runtime/runtime-context';

type Route = 'home' | 'today' | 'library' | 'records' | 'settings' | 'invites' | `focus/${string}`;
type TaskEditor = { kind: 'task' | 'daily'; item: Task | DailyTask | null } | null;

const NAV = [
  ['home', '专注', Home],
  ['today', '今日任务', ListTodo],
  ['library', '任务库', Library],
  ['records', '学习记录', Clock3],
  ['settings', '设置', SettingsIcon],
] as const;

const MOBILE_NAV = NAV.slice(0, 4);

const ADMIN_NAV = ['invites', '邀请管理', UserPlus] as const;

function ExamCountdownCard() {
  const countdown = getExamCountdown();
  const message = countdown.status === 'upcoming'
    ? <><strong>{countdown.days}</strong><span>天至初试</span></>
    : countdown.status === 'today'
      ? <><strong>今天</strong><span>初试日</span></>
      : <><strong>已结束</strong><span>初试日期已过</span></>;
  return <section className="exam-countdown" aria-label="考研初试倒计时">
    <small>考研日期倒计时</small>
    <div>{message}</div>
    <p>按本地自然日计算</p>
  </section>;
}

function currentRoute(): Route {
  return (globalThis.location?.hash?.replace(/^#\/?/, '') || 'home') as Route;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function PageHeader({ title, description, action }: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return <header className="page-header"><div><h1>{title}</h1><p>{description}</p></div>{action}</header>;
}

function Empty({ title, text, action }: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return <div className="empty"><span><Sprout /></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function TimerEntry({ timerState, onOpen }: {
  timerState: ReturnType<typeof useTimerState>;
  onOpen: () => void;
}) {
  const timer = timerState.viewModel.timer;
  if (!timer) return null;
  const stateLabel = timer.status === 'paused' || timer.status === 'pausing'
    ? '已暂停'
    : timerState.viewModel.pending
      ? '等待同步'
      : '进行中';
  return <section className="timer-entry" aria-label="当前活动计时器">
    <div><Clock3 size={20} /><span><strong>当前计时器</strong><small aria-live="polite">{stateLabel}</small></span></div>
    <span className="timer-entry__clock" aria-label={`剩余时间 ${timerState.clockText}`}>{timerState.clockText}</span>
    <button className="button button--primary button--small" type="button" onClick={onOpen}>返回当前计时器</button>
  </section>;
}

function MobileMoreDrawer({
  open,
  onClose,
  onSettings,
  onInvites,
  onLogout,
  sync,
  isAdmin,
  username,
  role,
  conflictCount,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  onSettings: () => void;
  onInvites: () => void;
  onLogout: () => void;
  sync: React.ReactNode;
  isAdmin: boolean;
  username: string | null;
  role: 'admin' | 'user' | null;
  conflictCount: number;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
  }, [onClose, open, triggerRef]);

  if (!open) return null;
  const openSettings = () => { onClose(); onSettings(); };
  const openInvites = () => { onClose(); onInvites(); };
  const logout = () => { onClose(); onLogout(); };

  return <div className="mobile-more-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="mobile-more" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title">
      <header>
        <div><strong id="mobile-more-title">更多</strong><small>账号、同步与管理</small></div>
        <button ref={closeRef} className="icon-button" type="button" aria-label="关闭更多功能" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="mobile-more__identity">
        <span>当前账号</span>
        <strong>{username ?? '本机用户'}</strong>
        <small>{role === 'admin' ? '管理员' : role === 'user' ? '普通用户' : '离线会话'}</small>
      </div>
      <button className="mobile-more__item" type="button" onClick={openSettings}>
        <SettingsIcon size={19} /><span><strong>设置与账号</strong><small>密码、设备、提醒与计时规则</small></span><ArrowRight size={17} />
      </button>
      <div className="mobile-more__sync">{sync}</div>
      <button className="mobile-more__item" type="button" onClick={openSettings}>
        <Focus size={19} /><span><strong>同步冲突</strong><small>{conflictCount ? `${conflictCount} 项需要处理` : '当前没有待处理冲突'}</small></span><ArrowRight size={17} />
      </button>
      {isAdmin ? <button className="mobile-more__item" type="button" onClick={openInvites}><UserPlus size={19} /><span><strong>邀请管理</strong><small>创建、复制或撤销一次性邀请</small></span><ArrowRight size={17} /></button> : null}
      <button className="mobile-more__item mobile-more__item--danger" type="button" onClick={logout}><LogOut size={19} /><span><strong>退出当前账号</strong><small>本机未同步的修改会继续保留</small></span><ArrowRight size={17} /></button>
    </section>
  </div>;
}

function Shell({ route, go, sync, isAdmin, username, role, conflictCount, onLogout, children }: {
  route: Route;
  go: (route: Route) => void;
  sync: React.ReactNode;
  isAdmin: boolean;
  username: string | null;
  role: 'admin' | 'user' | null;
  conflictCount: number;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  return <div className="app-shell">
    <aside className="sidebar">
      <Brand onActivate={() => go('home')} />
      <ExamCountdownCard />
      <nav className="side-nav" aria-label="主要导航">{NAV.map(([key, label, Icon]) => <button key={key} className={route === key ? 'nav-item nav-item--active' : 'nav-item'} type="button" onClick={() => go(key)}><Icon size={19} /><span>{label}</span></button>)}</nav>
      {isAdmin ? <><p className="side-nav__label">管理</p><nav className="side-nav side-nav--admin" aria-label="管理员导航"><button className={route === ADMIN_NAV[0] ? 'nav-item nav-item--active' : 'nav-item'} type="button" onClick={() => go(ADMIN_NAV[0])}><UserPlus size={19} /><span>{ADMIN_NAV[1]}</span></button></nav></> : null}
      <div className="sidebar-sync">{sync}</div>
    </aside>
    <main className="app-main"><div className="mobile-sync">{sync}</div>{children}</main>
    <nav className="bottom-nav" aria-label="手机导航">{MOBILE_NAV.map(([key, label, Icon]) => <button key={key} className={route === key ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'} type="button" onClick={() => { closeMore(); go(key); }}><Icon size={19} /><span>{label}</span></button>)}<button ref={moreButtonRef} className={moreOpen || route === 'settings' || route === 'invites' ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'} type="button" aria-expanded={moreOpen} aria-haspopup="dialog" onClick={() => setMoreOpen((open) => !open)}><MoreHorizontal size={20} /><span>更多</span></button></nav>
    <MobileMoreDrawer open={moreOpen} onClose={closeMore} onSettings={() => go('settings')} onInvites={() => go('invites')} onLogout={onLogout} sync={sync} isAdmin={isAdmin} username={username} role={role} conflictCount={conflictCount} triggerRef={moreButtonRef} />
  </div>;
}

function SettingsPage({ settings, settingsId, conflicts, onSave, toast }: {
  settings: Settings | null;
  settingsId: string | null;
  conflicts: Parameters<typeof ConflictCenter>[0]['conflicts'];
  onSave: (id: string, patch: Partial<Settings>) => Promise<void>;
  toast: (message: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => ({ ...DEFAULT_SETTINGS, ...(settings ?? {}) }));
  useEffect(() => setDraft({ ...DEFAULT_SETTINGS, ...(settings ?? {}) }), [settings]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settingsId) return toast('设置仍在同步，请稍后再试。', true);
    const patch: Pick<Settings,
      'defaultPreset' | 'customFocusMinutes' | 'customShortBreakMinutes' |
      'customLongBreakMinutes' | 'longBreakInterval' | 'soundEnabled' |
      'notificationsEnabled'> = {
      defaultPreset: draft.defaultPreset as Settings['defaultPreset'],
      customFocusMinutes: Math.min(180, Math.max(1, Number(draft.customFocusMinutes))),
      customShortBreakMinutes: Math.min(60, Math.max(1, Number(draft.customShortBreakMinutes))),
      customLongBreakMinutes: Math.min(120, Math.max(1, Number(draft.customLongBreakMinutes))),
      longBreakInterval: Math.min(12, Math.max(1, Number(draft.longBreakInterval))),
      soundEnabled: Boolean(draft.soundEnabled),
      notificationsEnabled: Boolean(draft.notificationsEnabled),
    };
    await onSave(settingsId, patch);
  };
  const change = (key: keyof typeof draft, value: unknown) => setDraft((current) => ({ ...current, [key]: value }));
  return <section className="page">
    <PageHeader title="设置" description="按自己的节奏调整专注、休息和提醒。" />
    <form className="settings-grid" onSubmit={submit}>
      <section className="settings-card">
        <div className="settings-card__title"><div><h2>计时规则</h2><p>修改后会自动保存，并在其他设备上保持一致。</p></div><SettingsIcon /></div>
        <label className="field field--full"><span>默认计时模式</span><select value={draft.defaultPreset} onChange={(event) => change('defaultPreset', event.target.value)}>{Object.entries(PRESETS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="form-grid">
          <label className="field"><span>专注分钟</span><input type="number" min="1" max="180" value={draft.customFocusMinutes} onChange={(event) => change('customFocusMinutes', event.target.value)} /></label>
          <label className="field"><span>短休息分钟</span><input type="number" min="1" max="60" value={draft.customShortBreakMinutes} onChange={(event) => change('customShortBreakMinutes', event.target.value)} /></label>
          <label className="field"><span>长休息分钟</span><input type="number" min="1" max="120" value={draft.customLongBreakMinutes} onChange={(event) => change('customLongBreakMinutes', event.target.value)} /></label>
          <label className="field"><span>长休息间隔</span><input type="number" min="1" max="12" value={draft.longBreakInterval} onChange={(event) => change('longBreakInterval', event.target.value)} /></label>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-card__title"><div><h2>提醒</h2><p>选择计时结束时希望收到的提醒。</p></div><Focus /></div>
        <label className="toggle"><span><span><strong>完成提示音</strong><small>计时结束时播放简短提示</small></span></span><input type="checkbox" checked={draft.soundEnabled} onChange={(event) => change('soundEnabled', event.target.checked)} /></label>
        <label className="toggle"><span><span><strong>桌面通知</strong><small>离开标签页时也能收到提醒</small></span></span><input type="checkbox" checked={draft.notificationsEnabled} onChange={(event) => change('notificationsEnabled', event.target.checked)} /></label>
      </section>
      <div className="settings-save"><button className="button button--primary" type="submit" disabled={!settingsId}><Save size={17} />保存设置</button></div>
    </form>
    <div className="settings-grid settings-grid--account"><AccountPanel /><ConflictCenter conflicts={conflicts} /></div>
  </section>;
}

function AppContent() {
  const runtime = useRuntime();
  const { activeUserId, authMode, username, session } = useRuntimeSnapshot();
  const data = useReplicaData(runtime.database, activeUserId);
  const timerState = useTimerState(runtime.database, activeUserId);
  const queue = activeUserId ? runtime.queueFor(activeUserId) : null;
  const [route, setRoute] = useState<Route>(currentRoute);
  const [editor, setEditor] = useState<TaskEditor>(null);
  const [toastState, setToastState] = useState<{ message: string; error: boolean } | null>(null);
  const toast = useCallback((message: string, error = false) => {
    setToastState({ message, error });
    window.setTimeout(() => setToastState(null), 2800);
  }, []);
  const go = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
    setRoute(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);
  useEffect(() => {
    if (!window.location.hash) window.location.hash = '#/home';
    const update = () => setRoute(currentRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  const today = getDateKey();
  const todayTasks = useMemo(() => data.dailyTasks.filter((task) => task.date === today).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)), [data.dailyTasks, today]);
  const summary = useMemo(() => getSummary(data.dailyTasks, data.focusSessions, today), [data.dailyTasks, data.focusSessions, today]);
  const visibleTimer = timerState.viewModel.timer;
  const run = async (work: () => Promise<unknown>, success: string) => {
    try { await work(); toast(success); } catch (error) { toast(error instanceof Error ? error.message : '操作失败', true); }
  };

  const saveTask = async (input: { title: string; subject: string; target: number; preset: '25-5' | '50-10' | 'custom' }) => {
    if (!queue || !editor) throw new Error('暂时无法保存，请稍后再试');
    const value = validateTaskInput(input);
    if (editor.kind === 'task') {
      if (editor.item) await queue.updateTask(editor.item.id, { title: value.title, subject: value.subject, defaultPomodoroTarget: value.target, defaultTimerPreset: value.preset });
      else await queue.createTask(crypto.randomUUID(), { title: value.title, subject: value.subject, defaultPomodoroTarget: value.target, defaultTimerPreset: value.preset, notes: null });
    } else if (editor.item) {
      await queue.updateDailyTask(editor.item.id, { title: value.title, subject: value.subject, pomodoroTarget: value.target, timerPreset: value.preset });
    } else {
      await queue.createDailyTask(crypto.randomUUID(), { sourceTaskId: null, date: today, title: value.title, subject: value.subject, pomodoroTarget: value.target, timerPreset: value.preset, sortOrder: todayTasks.length });
    }
    setEditor(null);
    toast('任务已保存');
  };

  const addToday = (task: Task) => {
    if (!queue) return;
    if (todayTasks.some((daily) => daily.sourceTaskId === task.id)) return toast('这个任务今天已经添加过了', true);
    void run(() => queue.addToToday(crypto.randomUUID(), { sourceTaskId: task.id, date: today, sortOrder: todayTasks.length }), '已加入今日任务');
  };
  const toggleDaily = (task: DailyTask) => {
    if (!queue) return;
    void run(() => task.status === 'completed' ? queue.restoreDailyTask(task.id) : queue.completeDailyTask(task.id), task.status === 'completed' ? '已恢复任务' : '已标记完成');
  };
  const deleteDaily = (task: DailyTask) => {
    if (queue && window.confirm(`删除“${task.title}”？`)) void run(() => queue.deleteDailyTask(task.id), '今日任务已删除');
  };
  const moveDaily = (task: DailyTask, direction: number) => {
    if (!queue) return;
    const index = todayTasks.findIndex((value) => value.id === task.id);
    const other = todayTasks[index + direction];
    if (!other) return;
    void run(async () => {
      await queue.updateDailyTask(task.id, { sortOrder: other.sortOrder });
      await queue.updateDailyTask(other.id, { sortOrder: task.sortOrder });
    }, '顺序已更新');
  };
  const openOrStartFocus = (task: DailyTask) => {
    if (!queue) return;
    if (visibleTimer) {
      go(`focus/${visibleTimer.dailyTaskId}`);
      toast('已切换到当前正在进行的计时器');
      return;
    }
    const durations = getDurations(
      { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
      task.timerPreset,
    );
    void run(async () => {
      await queue.startTimerForDailyTask(
        crypto.randomUUID(), task.id, 'focus', durations.focus,
      );
      go(`focus/${task.id}`);
    }, '专注已开始');
  };

  useEffect(() => {
    if (!route.startsWith('focus/') || !visibleTimer) return;
    const routedTaskId = route.slice('focus/'.length);
    if (routedTaskId === visibleTimer.dailyTaskId) return;
    go(`focus/${visibleTimer.dailyTaskId}`);
    toast(
      timerState.viewModel.reconciliation?.errorCode === 'TIMER_ALREADY_ACTIVE'
        ? '已切换到其他设备上的当前计时器'
        : '已切换到当前正在进行的计时器',
    );
  }, [go, route, timerState.viewModel.reconciliation?.errorCode, toast, visibleTimer]);

  if (!data.loaded) return <main className="login-page"><p role="status">正在准备你的学习计划…</p></main>;
  const sync = <SyncStatusPanel pendingCount={data.pendingCount} rejectedCount={data.rejectedCount} conflictCount={data.openConflictCount} syncIssues={data.syncIssues} />;
  const settings = data.settings as Settings | null;
  const activeTasks = data.tasks.filter((task) => !task.archived);
  let page: React.ReactNode;

  if (route === 'today') page = <section className="page">
    <PageHeader title="今日任务" description="选好今天要做的事，然后一项一项完成。" action={<button className="button button--primary" type="button" onClick={() => setEditor({ kind: 'daily', item: null })}><Plus size={17} />添加今日任务</button>} />
    <section className="panel"><div className="section-title"><div><h2>今天的计划</h2><p>{todayTasks.length} 项任务 · 已完成 {summary.completed} 项</p></div></div>
      {visibleTimer ? <TimerEntry timerState={timerState} onOpen={() => go(`focus/${visibleTimer.dailyTaskId}`)} /> : null}
      {todayTasks.length ? <div className="task-list">{todayTasks.map((task) => <TaskRow key={task.id} task={task} startLabel={visibleTimer ? '查看当前计时器' : '开始专注'} onStart={() => openOrStartFocus(task)} onToggle={toggleDaily} onEdit={(item: DailyTask) => setEditor({ kind: 'daily', item })} onDelete={deleteDaily} onMove={moveDaily} />)}</div> : <Empty title="今天还没有任务" text="临时添加一个，或从长期任务库选择。" />}
    </section>
    <section className="panel library-picker"><div className="section-title"><div><h2>从任务库添加</h2><p>把长期任务安排到今天，原任务仍会保留。</p></div><button className="text-link text-link--green" type="button" onClick={() => go('library')}>管理任务库<ArrowRight size={15} /></button></div>
      <div className="template-list">{activeTasks.map((task) => <article className="template-row" key={task.id}><div><SubjectBadge subject={task.subject} /><strong>{task.title}</strong><span>{task.defaultPomodoroTarget} 个番茄 · {PRESETS[task.defaultTimerPreset]}</span></div><button className="button button--outline button--small" type="button" onClick={() => addToday(task)}><Plus size={15} />加入今天</button></article>)}</div>
    </section>
  </section>;
  else if (route === 'library') page = <section className="page">
    <PageHeader title="任务库" description="把需要长期推进的复习任务放在这里，随时安排到今天。" action={<button className="button button--primary" type="button" onClick={() => setEditor({ kind: 'task', item: null })}><Plus size={17} />新建长期任务</button>} />
    <section className="panel"><div className="section-title"><div><h2>长期任务</h2><p>{activeTasks.length} 项正在使用</p></div></div>
      {data.tasks.length ? <div className="template-grid">{data.tasks.map((task) => <article className={`template-card ${task.archived ? 'template-card--archived' : ''}`} key={task.id}><div className="template-card__top"><SubjectBadge subject={task.subject} /><BookOpen size={19} /></div><h3>{task.title}</h3><p>{task.defaultPomodoroTarget} 个番茄 · {PRESETS[task.defaultTimerPreset]}</p><div className="template-card__actions">
        {!task.archived ? <button className="button button--primary button--small" type="button" onClick={() => addToday(task)}><Plus size={15} />加入今天</button> : null}
        <button className="button button--ghost button--small" type="button" onClick={() => setEditor({ kind: 'task', item: task })}>编辑</button>
        <button className="icon-button" type="button" aria-label={`${task.archived ? '恢复' : '归档'}：${task.title}`} onClick={() => queue && void run(() => task.archived ? queue.unarchiveTask(task.id) : queue.archiveTask(task.id), task.archived ? '任务已恢复' : '任务已归档')}><Archive size={16} /></button>
        <button className="icon-button icon-button--danger" type="button" aria-label={`删除：${task.title}`} onClick={() => queue && window.confirm(`删除“${task.title}”？`) && void run(() => queue.deleteTask(task.id), '长期任务已删除')}><Trash2 size={16} /></button>
      </div></article>)}</div> : <Empty title="任务库还是空的" text="创建一个会重复出现的复习任务。" />}
    </section>
  </section>;
  else if (route === 'records') {
    const sessions = data.focusSessions.filter((session) => getIsoDateKey(session.startedAt) === today);
    page = <section className="page"><PageHeader title="专注记录" description="回顾每一次专注，看看今天把时间花在了哪里。" />
      <div className="record-summary"><div><Clock3 /><span>专注时长</span><strong>{formatDuration(summary.focusSeconds)}</strong></div><div><Focus /><span>完整番茄</span><strong>{summary.pomodoros} 个</strong></div></div>
      <section className="panel"><div className="section-title"><div><h2>今日时间线</h2><p>{sessions.length} 条记录</p></div></div>{sessions.length ? <div className="record-list">{sessions.map((session) => <article className="record-row" key={session.id}><i className={`record-icon record-icon--${session.result}`}><Clock3 size={18} /></i><div className="record-row__main"><div><strong>{session.result === 'completed' ? '完成专注' : session.result === 'interrupted' ? '专注中断' : '提前结束'}</strong><SubjectBadge subject={session.subject} /></div><h3>{session.taskTitle}</h3>{session.interruptionReason ? <p>原因：{session.interruptionReason}</p> : null}</div><div className="record-row__time"><strong>{formatDuration(session.effectiveSeconds)}</strong><span>{formatTime(session.startedAt)}–{formatTime(session.endedAt)}</span></div></article>)}</div> : <Empty title="今天还没有专注记录" text="完成一次专注后，记录会出现在这里。" />}</section>
    </section>;
  } else if (route === 'settings') page = <SettingsPage settings={settings} settingsId={settings?.id ?? null} conflicts={data.conflicts} toast={toast} onSave={(id, patch) => queue ? run(() => queue.updateSettings(id, patch), '设置已保存') : Promise.reject(new Error('暂时无法保存，请稍后再试'))} />;
  else if (route === 'invites' && runtime.getSnapshot().session?.user.role === 'admin') page = <InvitationManagement />;
  else if (route.startsWith('focus/')) {
    const routeTask = data.dailyTasks.find((value) => value.id === route.split('/')[1]) ?? null;
    const timerTask = visibleTimer
      ? data.dailyTasks.find((value) => value.id === visibleTimer.dailyTaskId) ?? null
      : null;
    const task = timerTask ?? routeTask;
    page = queue ? <TimerPage
      timerState={timerState}
      task={task}
      queue={queue}
      onBack={() => go('today')}
      onTimerSwitch={(dailyTaskId) => go(`focus/${dailyTaskId}`)}
      onManualSync={() => runtime.manualSync()}
      onMessage={toast}
      onStartPhase={(phase) => {
        if (!task) return Promise.reject(new Error('今日任务不可用'));
        const durations = getDurations(
          { ...DEFAULT_SETTINGS, ...(settings ?? {}) },
          task.timerPreset,
        );
        return run(
          () => queue.startTimerForDailyTask(
            crypto.randomUUID(),
            task.id,
            phase,
            phase === 'short_break' ? durations.shortBreak : durations.longBreak,
          ),
          phase === 'short_break' ? '短休息已开始' : '长休息已开始',
        );
      }}
      onConfirmTask={() => task
        ? run(() => queue.completeDailyTask(task.id), '今日任务已确认完成')
        : Promise.reject(new Error('今日任务不可用'))}
    /> : <main className="focus-page"><p role="status">正在准备专注计时…</p></main>;
  } else page = <FocusDashboard
    todayTasks={todayTasks}
    summary={summary}
    timerState={timerState}
    activeTask={visibleTimer ? data.dailyTasks.find((task) => task.id === visibleTimer.dailyTaskId) ?? null : null}
    offline={authMode === 'offline'}
    onAddTask={() => setEditor({ kind: 'daily', item: null })}
    onPlanToday={() => go('today')}
    onStartTask={openOrStartFocus}
    onOpenTimer={() => visibleTimer && go(`focus/${visibleTimer.dailyTaskId}`)}
  />;

  return <>
    {route.startsWith('focus/') ? page : <Shell route={route} go={go} sync={sync} isAdmin={session?.user.role === 'admin'} username={username} role={session?.user.role ?? null} conflictCount={data.openConflictCount} onLogout={() => { void runtime.logout(); }}>{page}</Shell>}
    <Modal open={Boolean(editor)} title={editor?.item ? '编辑任务' : editor?.kind === 'task' ? '新建长期任务' : '添加今日任务'} onClose={() => setEditor(null)}>
      <TaskForm kind={editor?.kind === 'task' ? 'template' : 'daily'} initial={editor?.item} defaultPreset={settings?.defaultPreset ?? DEFAULT_SETTINGS.defaultPreset} onCancel={() => setEditor(null)} onSave={saveTask} />
    </Modal>
    {toastState ? <div className={toastState.error ? 'toast toast--error' : 'toast'} role={toastState.error ? 'alert' : 'status'}>{toastState.message}</div> : null}
  </>;
}

export default function SynchronizedApp() {
  return <RuntimeProvider><AuthExperience><AppContent /></AuthExperience></RuntimeProvider>;
}
