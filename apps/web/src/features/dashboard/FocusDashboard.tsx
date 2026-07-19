import type { DailyTask } from '@kaoyan/contracts';
import { ArrowRight, CalendarDays, ListTodo, Play } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { PRESETS } from '../../model.js';
import { AppSelect } from '../../components/AppSelect';
import type { TimerStateSnapshot } from '../timer/use-timer-state';

type Summary = {
  completed: number;
  total: number;
  focusSeconds: number;
  pomodoros: number;
};

function formatFocusedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function readyClock(task: DailyTask | null): string {
  if (!task) return '--:--';
  if (task.timerPreset === '50-10') return '50:00';
  if (task.timerPreset === 'custom') return '自定义';
  return '25:00';
}

export function FocusDashboard({
  todayTasks,
  summary,
  timerState,
  activeTask,
  offline,
  onAddTask,
  onPlanToday,
  onStartTask,
  onOpenTimer,
}: {
  todayTasks: DailyTask[];
  summary: Summary;
  timerState: TimerStateSnapshot;
  activeTask: DailyTask | null;
  offline: boolean;
  onAddTask: () => void;
  onPlanToday: () => void;
  onStartTask: (task: DailyTask) => void;
  onOpenTimer: () => void;
}) {
  const availableTasks = useMemo(
    () => todayTasks.filter((task) => task.status !== 'completed'),
    [todayTasks],
  );
  const [selectedId, setSelectedId] = useState(availableTasks[0]?.id ?? '');
  useEffect(() => {
    if (availableTasks.some((task) => task.id === selectedId)) return;
    setSelectedId(availableTasks[0]?.id ?? '');
  }, [availableTasks, selectedId]);

  const timer = timerState.viewModel.timer;
  const selectedTask = availableTasks.find((task) => task.id === selectedId) ?? null;
  const displayTask = activeTask ?? selectedTask;
  const paused = timer?.status === 'paused' || timer?.status === 'pausing';
  const timerLabel = timer
    ? paused ? '计时已暂停' : timerState.viewModel.pending ? '正在保存' : '专注进行中'
    : selectedTask ? '准备专注' : '等待安排任务';
  const progress = timer && timer.plannedSeconds > 0
    ? Math.min(1, Math.max(0, 1 - timerState.remainingMs / (timer.plannedSeconds * 1_000)))
    : 0;
  const ringStyle = {
    '--timer-progress': `${progress * 360}deg`,
  } as CSSProperties;
  const date = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());

  return <section className="focus-dashboard">
    <header className="editorial-header">
      <div>
        <p><CalendarDays size={15} />{date}</p>
        <h1>专注此刻</h1>
      </div>
      <div className="editorial-actions">
        <button className="button button--ghost" type="button" onClick={onAddTask}>添加任务</button>
        <button className="button button--primary" type="button" onClick={onPlanToday}><ListTodo size={17} />安排今日</button>
      </div>
    </header>

    <div className="focus-dashboard__layout">
      <section className="dashboard-timer" aria-label={timer ? '当前活动计时器' : '专注计时器'}>
        <div className="dashboard-timer__meta">
          <span>{timer ? '当前计时' : '专注阶段'}</span>
          <strong>{timerLabel}</strong>
        </div>
        <div className={`dashboard-timer__ring${paused ? ' dashboard-timer__ring--paused' : ''}`} style={ringStyle}>
          <div className="dashboard-timer__inner">
            <p>{timer ? '专注 / 进行中' : '专注 / 准备'}</p>
            <strong aria-live="polite">{timer ? timerState.clockText : readyClock(selectedTask)}</strong>
            <span>{offline ? '网络不可用，恢复后会继续保存学习记录' : timer ? timerState.clockLabel : '选定任务后，从一段完整专注开始'}</span>
            {timer ? <button className="timer-main-action" type="button" onClick={onOpenTimer}>
              <ArrowRight size={21} /><small>{paused ? '继续处理' : '打开计时'}</small>
            </button> : selectedTask ? <button className="timer-main-action" type="button" onClick={() => onStartTask(selectedTask)}>
              <Play size={21} /><small>开始</small>
            </button> : <button className="timer-main-action" type="button" onClick={onPlanToday}>
              <ListTodo size={20} /><small>安排任务</small>
            </button>}
          </div>
        </div>
      </section>

      <aside className="focus-context">
        <p className="section-kicker">当前任务</p>
        <h2>{displayTask?.title ?? '先安排今天的第一项任务'}</h2>
        {availableTasks.length ? <AppSelect
          className="focus-context__select"
          label="选择今日任务"
          labelClassName="sr-only"
          value={selectedId}
          disabled={Boolean(timer)}
          onChange={setSelectedId}
          options={availableTasks.map((task) => ({ value: task.id, label: task.title }))}
        /> : <p className="focus-context__empty">从长期任务库选择目标，或临时添加一项任务。</p>}
        <dl className="focus-context__details">
          <div><dt>今日任务</dt><dd>{summary.completed} / {summary.total}</dd></div>
          <div><dt>计时模式</dt><dd>{displayTask ? PRESETS[displayTask.timerPreset] : '—'}</dd></div>
        </dl>
        <div className="focus-context__rhythm">
          <p className="section-kicker">今日节奏</p>
          <div>
            <span><strong>{String(summary.pomodoros).padStart(2, '0')}</strong><small>完成专注</small></span>
            <span><strong>{formatFocusedTime(summary.focusSeconds)}</strong><small>累计时长</small></span>
            <span><strong>{summary.total}</strong><small>计划任务</small></span>
          </div>
        </div>
        <blockquote>稳定比燃烧更重要。<br />让每一次坐下都变得容易。</blockquote>
      </aside>
    </div>
  </section>;
}
