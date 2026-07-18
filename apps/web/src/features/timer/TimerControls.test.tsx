// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimerControls } from './TimerControls';

afterEach(cleanup);

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('timer controls', () => {
  it('offers only pause and exit while running', async () => {
    const onPause = vi.fn();
    render(<TimerControls
      state="running"
      onPause={onPause}
      onResume={vi.fn()}
      onExit={vi.fn()}
    />);
    expect(screen.getByRole('button', { name: '暂停计时器' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提前退出计时器' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续计时器' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '暂停计时器' }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('offers only resume and exit while paused', () => {
    render(<TimerControls
      state="paused"
      onPause={vi.fn()}
      onResume={vi.fn()}
      onExit={vi.fn()}
    />);
    expect(screen.getByRole('button', { name: '继续计时器' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '提前退出计时器' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '暂停计时器' })).toBeNull();
  });

  it.each([
    ['starting', '正在开始'],
    ['pausing', '正在暂停'],
    ['resuming', '正在继续'],
    ['completing', '正在确认完成'],
    ['exiting', '正在退出'],
  ] as const)(
    'disables duplicate controls while %s',
    (state, label) => {
      render(<TimerControls
        state={state}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onExit={vi.fn()}
      />);
      for (const button of screen.queryAllByRole('button'))
        expect(button).toHaveProperty('disabled', true);
      expect(screen.getByRole('status').textContent).toContain(label);
    },
  );

  it('submits a validated custom exit reason through an accessible dialog', async () => {
    const onExit = vi.fn();
    const user = userEvent.setup();
    render(<TimerControls
      state="running"
      onPause={vi.fn()}
      onResume={vi.fn()}
      onExit={onExit}
    />);
    await user.click(screen.getByRole('button', { name: '提前退出计时器' }));
    expect(screen.getByRole('dialog', { name: '提前退出' })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: '其他' }));
    await user.type(screen.getByLabelText('自定义退出原因'), '接听重要电话');
    await user.click(screen.getByRole('button', { name: '确认退出' }));
    expect(onExit).toHaveBeenCalledWith('接听重要电话');
  });

  it('immediately guards a deferred pause from duplicate clicks', async () => {
    const pending = deferred();
    const onPause = vi.fn(() => pending.promise);
    render(<TimerControls
      state="running"
      onPause={onPause}
      onResume={vi.fn()}
      onExit={vi.fn()}
    />);
    const pause = screen.getByRole('button', { name: '暂停计时器' });
    fireEvent.click(pause);
    fireEvent.click(pause);
    expect(onPause).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('正在暂停');
    await act(async () => pending.resolve());
  });

  it('immediately guards a deferred resume from duplicate clicks', async () => {
    const pending = deferred();
    const onResume = vi.fn(() => pending.promise);
    render(<TimerControls
      state="paused"
      onPause={vi.fn()}
      onResume={onResume}
      onExit={vi.fn()}
    />);
    const resume = screen.getByRole('button', { name: '继续计时器' });
    fireEvent.click(resume);
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
    for (const button of screen.getAllByRole('button'))
      expect(button).toHaveProperty('disabled', true);
    expect(screen.getByRole('status').textContent).toContain('正在继续');
    await act(async () => pending.resolve());
  });

  it('keeps the exit dialog open and re-enables it after a deferred failure', async () => {
    const pending = deferred();
    const onExit = vi.fn(() => pending.promise);
    render(<TimerControls
      state="running"
      onPause={vi.fn()}
      onResume={vi.fn()}
      onExit={onExit}
    />);
    fireEvent.click(screen.getByRole('button', { name: '提前退出计时器' }));
    const submit = screen.getByRole('button', { name: '确认退出' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '取消' }))
      .toHaveProperty('disabled', true);
    expect(submit).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    const backdrop = document.querySelector('.modal-backdrop');
    if (!backdrop) throw new Error('Expected the exit dialog backdrop');
    fireEvent.mouseDown(backdrop);
    expect(screen.getByRole('dialog', { name: '提前退出' })).toBeTruthy();
    await act(async () => pending.reject(new Error('网络暂时不可用')));
    expect((await screen.findByRole('alert')).textContent)
      .toContain('计时操作暂时无法完成，请重试。');
    expect(screen.getByRole('dialog', { name: '提前退出' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认退出' }))
      .toHaveProperty('disabled', false);
  });

  it('closes the exit dialog after one successful deferred submission', async () => {
    const pending = deferred();
    const onExit = vi.fn(() => pending.promise);
    render(<TimerControls
      state="running"
      onPause={vi.fn()}
      onResume={vi.fn()}
      onExit={onExit}
    />);
    fireEvent.click(screen.getByRole('button', { name: '提前退出计时器' }));
    const submit = screen.getByRole('button', { name: '确认退出' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onExit).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: '提前退出' }),
    ).toBeNull());
  });
});
