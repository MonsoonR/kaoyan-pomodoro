import React, { useEffect, useId, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Edit3,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import { PRESETS, SUBJECTS } from './model.js';

export function Modal({ open, title, children, onClose, size = 'medium', dismissible = true }) {
  const titleId = useId();
  const ref = useRef(null);
  const returnFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  }, [dismissible, onClose]);
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement;
    const handler = (event) => {
      if (dismissibleRef.current && event.key === 'Escape') {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', handler);
    queueMicrotask(() => ref.current?.focus());
    return () => {
      document.removeEventListener('keydown', handler);
      const returnFocus = returnFocusRef.current;
      queueMicrotask(() => {
        if (!returnFocus?.isConnected) return;
        try { returnFocus.focus?.(); } catch { /* the trigger may be gone */ }
      });
    };
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => dismissible && event.target === event.currentTarget && onClose()}>
      <div ref={ref} className={`modal modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal__header">
          <h2 id={titleId}>{title}</h2>
          {dismissible ? <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button> : null}
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

export function Progress({ value, max, label }) {
  const safeMax = Math.max(1, Number(max) || 1);
  const percent = Math.max(0, Math.min(100, (Number(value) / safeMax) * 100));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax={safeMax} aria-valuenow={Number(value) || 0}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SubjectBadge({ subject }) {
  return <span className={`subject subject--${subject}`}>{SUBJECTS[subject] ?? '其他'}</span>;
}

export function TaskForm({ kind, initial, defaultPreset, onCancel, onSave }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [subject, setSubject] = useState(initial?.subject ?? 'math');
  const [target, setTarget] = useState(initial?.pomodoroTarget ?? initial?.defaultPomodoroTarget ?? 1);
  const [preset, setPreset] = useState(initial?.timerPreset ?? initial?.defaultTimerPreset ?? defaultPreset);
  const [error, setError] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    try {
      await onSave({ title, subject, target: Number(target), preset });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    }
  };
  return (
    <form className="task-form" onSubmit={submit}>
      <label className="field field--full"><span>任务名称</span><input autoFocus maxLength="60" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'template' ? '例如：高数极限基础题' : '例如：完成高数练习 30 道'} /></label>
      <div className="form-grid">
        <label className="field"><span>科目</span><select value={subject} onChange={(e) => setSubject(e.target.value)}>{Object.entries(SUBJECTS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
        <label className="field"><span>预计番茄数</span><input type="number" min="1" max="12" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
        <label className="field field--full"><span>计时模式</span><select value={preset} onChange={(e) => setPreset(e.target.value)}>{Object.entries(PRESETS).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions"><button className="button button--ghost" type="button" onClick={onCancel}>取消</button><button className="button button--primary" type="submit">保存任务</button></div>
    </form>
  );
}

// Default callback parameters document the callable prop shape for checked JSX.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function TaskRow({ task, compact = false, onStart, onToggle, onEdit = (_task) => {}, onDelete = (_task) => {}, onMove = (_task, _direction) => {} }) {
  const completed = task.status === 'completed';
  const awaiting = task.status === 'awaiting_confirmation';
  return (
    <article className={`task-row ${completed ? 'task-row--completed' : ''}`}>
      <button className={`check-button ${completed ? 'check-button--checked' : ''}`} type="button" aria-label={`${completed ? '取消完成' : '标记完成'}：${task.title}`} onClick={() => onToggle(task)}>{completed ? <Check size={16} /> : null}</button>
      <div className="task-row__main">
        <div className="task-row__title"><SubjectBadge subject={task.subject} /><strong>{task.title}</strong>{completed ? <span className="status status--done">已完成</span> : awaiting ? <span className="status status--wait">待确认</span> : null}</div>
        <div className="task-row__meta"><span>{task.pomodoroCompleted} / {task.pomodoroTarget} 个番茄</span><span>{PRESETS[task.timerPreset]}</span></div>
        <Progress value={task.pomodoroCompleted} max={task.pomodoroTarget} label={`${task.title} 番茄进度`} />
      </div>
      <div className="task-row__actions">
        {!completed ? <button className="button button--outline button--small" type="button" aria-label={`开始专注：${task.title}`} onClick={() => onStart(task)}><Play size={15} />开始专注</button> : null}
        {!compact ? <>
          <button className="icon-button" type="button" aria-label={`编辑：${task.title}`} onClick={() => onEdit(task)}><Edit3 size={16} /></button>
          {onMove ? <><button className="icon-button" type="button" aria-label={`上移：${task.title}`} onClick={() => onMove(task, -1)}><ArrowUp size={16} /></button><button className="icon-button" type="button" aria-label={`下移：${task.title}`} onClick={() => onMove(task, 1)}><ArrowDown size={16} /></button></> : null}
          <button className="icon-button icon-button--danger" type="button" aria-label={`删除：${task.title}`} onClick={() => onDelete(task)}><Trash2 size={16} /></button>
        </> : null}
      </div>
    </article>
  );
}
