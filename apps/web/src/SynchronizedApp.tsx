import type { DailyTask, Settings, Task } from '@kaoyan/contracts';
import {
  Archive,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Clock3,
  Focus,
  Home,
  Library,
  ListTodo,
  Plus,
  Save,
  Settings as SettingsIcon,
  Sprout,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Progress, SubjectBadge, TaskForm, TaskRow } from './components.jsx';
import { AccountPanel } from './features/devices/AccountPanel';
import { AuthExperience } from './features/auth/AuthExperience';
import { ConflictCenter } from './features/conflicts/ConflictCenter';
import { useReplicaData } from './features/replicas/use-replica-data';
import { SyncStatusPanel } from './features/sync/SyncStatusPanel';
import {
  DEFAULT_SETTINGS,
  PRESETS,
  formatDuration,
  getDateKey,
  getIsoDateKey,
  getSummary,
  validateTaskInput,
} from './model.js';
import { RuntimeProvider, useRuntime, useRuntimeSnapshot } from './runtime/runtime-context';

type Route = 'home' | 'today' | 'library' | 'records' | 'settings' | `focus/${string}`;
type TaskEditor = { kind: 'task' | 'daily'; item: Task | DailyTask | null } | null;

const NAV = [
  ['home', '首页', Home],
  ['today', '今日任务', ListTodo],
  ['library', '任务库', Library],
  ['records', '专注记录', Clock3],
  ['settings', '设置', SettingsIcon],
] as const;

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

function Shell({ route, go, sync, children }: {
  route: Route;
  go: (route: Route) => void;
  sync: React.ReactNode;
  children: React.ReactNode;
}) {
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => go('home')} aria-label="返回首页">
        <span className="brand__mark">♧</span><span><strong>考研番茄钟</strong><small>Focus · Plan · Achieve</small></span>
      </button>
      <nav className="side-nav" aria-label="主要导航">{NAV.map(([key, label, Icon]) => <button key={key} className={route === key ? 'nav-item nav-item--active' : 'nav-item'} type="button" onClick={() => go(key)}><Icon size={19} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-sync">{sync}</div>
      <div className="side-note"><small>今天只做一件事</small><strong>完成下一个专注</strong></div>
    </aside>
    <main className="app-main"><div className="mobile-sync">{sync}</div>{children}</main>
    <nav className="bottom-nav" aria-label="手机导航">{NAV.map(([key, label, Icon]) => <button key={key} className={route === key ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'} type="button" onClick={() => go(key)}><Icon size={19} /><span>{label}</span></button>)}</nav>
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
    <PageHeader title="设置" description="计时偏好会保存到同步副本，并在登录设备间保持一致。" />
    <form className="settings-grid" onSubmit={submit}>
      <section className="settings-card">
        <div className="settings-card__title"><div><h2>计时规则</h2><p>设置更新会先在本机生效，再自动同步。</p></div><SettingsIcon /></div>
        <label className="field field--full"><span>默认计时模式</span><select value={draft.defaultPreset} onChange={(event) => change('defaultPreset', event.target.value)}>{Object.entries(PRESETS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <div className="form-grid">
          <label className="field"><span>专注分钟</span><input type="number" min="1" max="180" value={draft.customFocusMinutes} onChange={(event) => change('customFocusMinutes', event.target.value)} /></label>
          <label className="field"><span>短休息分钟</span><input type="number" min="1" max="60" value={draft.customShortBreakMinutes} onChange={(event) => change('customShortBreakMinutes', event.target.value)} /></label>
          <label className="field"><span>长休息分钟</span><input type="number" min="1" max="120" value={draft.customLongBreakMinutes} onChange={(event) => change('customLongBreakMinutes', event.target.value)} /></label>
          <label className="field"><span>长休息间隔</span><input type="number" min="1" max="12" value={draft.longBreakInterval} onChange={(event) => change('longBreakInterval', event.target.value)} /></label>
        </div>
      </section>
      <section className="settings-card">
        <div className="settings-card__title"><div><h2>提醒</h2><p>权限由当前浏览器管理，偏好会同步。</p></div><Focus /></div>
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
  const { activeUserId, authMode } = useRuntimeSnapshot();
  const data = useReplicaData(runtime.database, activeUserId);
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
  const run = async (work: () => Promise<unknown>, success: string) => {
    try { await work(); toast(success); } catch (error) { toast(error instanceof Error ? error.message : '操作失败', true); }
  };

  const saveTask = async (input: { title: string; subject: string; target: number; preset: '25-5' | '50-10' | 'custom' }) => {
    if (!queue || !editor) throw new Error('本地同步队列尚未准备好');
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

  if (!data.loaded) return <main className="login-page"><p role="status">正在读取本地同步副本…</p></main>;
  const sync = <SyncStatusPanel pendingCount={data.pendingCount} rejectedCount={data.rejectedCount} conflictCount={data.openConflictCount} syncIssues={data.syncIssues} />;
  const settings = data.settings as Settings | null;
  const activeTasks = data.tasks.filter((task) => !task.archived);
  let page: React.ReactNode;

  if (route === 'today') page = <section className="page">
    <PageHeader title="今日任务" description="只安排今天能完成的内容，操作会先写入本地队列。" action={<button className="button button--primary" type="button" onClick={() => setEditor({ kind: 'daily', item: null })}><Plus size={17} />添加今日任务</button>} />
    <section className="panel"><div className="section-title"><div><h2>今天的计划</h2><p>{todayTasks.length} 项任务 · 已完成 {summary.completed} 项</p></div></div>
      {todayTasks.length ? <div className="task-list">{todayTasks.map((task) => <TaskRow key={task.id} task={task} onStart={() => go(`focus/${task.id}`)} onToggle={toggleDaily} onEdit={(item: DailyTask) => setEditor({ kind: 'daily', item })} onDelete={deleteDaily} onMove={moveDaily} />)}</div> : <Empty title="今天还没有任务" text="临时添加一个，或从长期任务库选择。" />}
    </section>
    <section className="panel library-picker"><div className="section-title"><div><h2>从任务库添加</h2><p>加入今日时，来源版本由离线队列预测。</p></div><button className="text-link text-link--green" type="button" onClick={() => go('library')}>管理任务库<ArrowRight size={15} /></button></div>
      <div className="template-list">{activeTasks.map((task) => <article className="template-row" key={task.id}><div><SubjectBadge subject={task.subject} /><strong>{task.title}</strong><span>{task.defaultPomodoroTarget} 个番茄 · {PRESETS[task.defaultTimerPreset]}</span></div><button className="button button--outline button--small" type="button" onClick={() => addToday(task)}><Plus size={15} />加入今天</button></article>)}</div>
    </section>
  </section>;
  else if (route === 'library') page = <section className="page">
    <PageHeader title="任务库" description="长期任务来自 IndexedDB 投影，离线编辑也会立即显示。" action={<button className="button button--primary" type="button" onClick={() => setEditor({ kind: 'task', item: null })}><Plus size={17} />新建长期任务</button>} />
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
    page = <section className="page"><PageHeader title="专注记录" description="记录由服务器计时器生成；本页只读，不会创建 focusSession 操作。" />
      <div className="record-summary"><div><Clock3 /><span>专注时长</span><strong>{formatDuration(summary.focusSeconds)}</strong></div><div><Focus /><span>完整番茄</span><strong>{summary.pomodoros} 个</strong></div></div>
      <section className="panel"><div className="section-title"><div><h2>今日时间线</h2><p>{sessions.length} 条记录</p></div></div>{sessions.length ? <div className="record-list">{sessions.map((session) => <article className="record-row" key={session.id}><i className={`record-icon record-icon--${session.result}`}><Clock3 size={18} /></i><div className="record-row__main"><div><strong>{session.result === 'completed' ? '完成专注' : session.result === 'interrupted' ? '专注中断' : '提前结束'}</strong><SubjectBadge subject={session.subject} /></div><h3>{session.taskTitle}</h3>{session.interruptionReason ? <p>原因：{session.interruptionReason}</p> : null}</div><div className="record-row__time"><strong>{formatDuration(session.effectiveSeconds)}</strong><span>{formatTime(session.startedAt)}–{formatTime(session.endedAt)}</span></div></article>)}</div> : <Empty title="今天还没有专注记录" text="完成服务器计时器后，记录会随增量同步出现。" />}</section>
    </section>;
  } else if (route === 'settings') page = <SettingsPage settings={settings} settingsId={settings?.id ?? null} conflicts={data.conflicts} toast={toast} onSave={(id, patch) => queue ? run(() => queue.updateSettings(id, patch), '设置已保存') : Promise.reject(new Error('同步队列未准备好'))} />;
  else if (route.startsWith('focus/')) {
    const task = data.dailyTasks.find((value) => value.id === route.split('/')[1]);
    page = <section className="focus-page"><div className="focus-card"><SubjectBadge subject={task?.subject ?? 'other'} /><h1>{task?.title ?? '未找到任务'}</h1><div className="focus-ready"><Clock3 /><h2>计时器暂处于兼容边界</h2><p>Task 8 只接入账号与非计时器同步数据。全局计时器控制、跨设备倒计时和离线计时冲突将在 Task 9 完成。</p></div><button className="button button--primary" type="button" onClick={() => go('today')}>返回今日任务</button></div></section>;
  } else page = <section className="dashboard">
    <header className="hero"><div><div className="date-line"><CalendarDays size={16} />{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())}</div><h1>今天也稳稳推进。</h1><p>{authMode === 'offline' ? '当前离线，本机操作会保留并在联网后同步。' : '先完成眼前这一项，不需要一次想完所有事情。'}</p></div><div className="hero__actions"><button className="button button--ghost" type="button" onClick={() => setEditor({ kind: 'daily', item: null })}><Plus size={17} />添加任务</button><button className="button button--primary" type="button" onClick={() => go('today')}><ListTodo size={17} />安排今日任务</button></div></header>
    <div className="summary-grid"><article className="summary-card"><div className="summary-card__title"><span>今日任务进度</span><i><Sprout /></i></div><div className="summary-number"><strong>{summary.completed} / {summary.total}</strong><span>项已完成</span></div><Progress value={summary.completed} max={summary.total} label="今日任务完成进度" /></article><article className="summary-card"><div className="summary-card__title"><span>今日专注时长</span><i><Clock3 /></i></div><div className="summary-number"><strong>{formatDuration(summary.focusSeconds)}</strong></div><p className="summary-note"><Focus size={16} />完成番茄 {summary.pomodoros} 个</p></article></div>
    <section className="panel"><div className="section-title"><div><h2>今日任务</h2><p>按计划逐项完成</p></div><button className="text-link text-link--green" type="button" onClick={() => go('today')}>管理任务<ArrowRight size={15} /></button></div>{todayTasks.length ? <div className="task-list">{todayTasks.map((task) => <TaskRow key={task.id} task={task} compact onStart={() => go(`focus/${task.id}`)} onToggle={toggleDaily} />)}</div> : <Empty title="先安排今天的第一项任务" text="从任务库挑选一个目标，或者临时添加。" action={<button className="button button--primary" type="button" onClick={() => go('today')}>安排今日任务</button>} />}</section>
  </section>;

  return <>
    {route.startsWith('focus/') ? page : <Shell route={route} go={go} sync={sync}>{page}</Shell>}
    <Modal open={Boolean(editor)} title={editor?.item ? '编辑任务' : editor?.kind === 'task' ? '新建长期任务' : '添加今日任务'} onClose={() => setEditor(null)}>
      <TaskForm kind={editor?.kind === 'task' ? 'template' : 'daily'} initial={editor?.item} defaultPreset={settings?.defaultPreset ?? DEFAULT_SETTINGS.defaultPreset} onCancel={() => setEditor(null)} onSave={saveTask} />
    </Modal>
    {toastState ? <div className={toastState.error ? 'toast toast--error' : 'toast'} role={toastState.error ? 'alert' : 'status'}>{toastState.message}</div> : null}
  </>;
}

export default function SynchronizedApp() {
  return <RuntimeProvider><AuthExperience><AppContent /></AuthExperience></RuntimeProvider>;
}
