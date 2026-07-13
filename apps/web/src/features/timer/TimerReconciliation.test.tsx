// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TimerReconciliation } from './TimerReconciliation';

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

const model = {
  operationId: 'operation',
  operationCreatedAt: '2026-07-13T04:00:00.000Z',
  attemptedAction: '暂停',
  errorCode: 'STALE_TIMER_VERSION',
  explanation: '操作基于旧的计时器版本，服务器状态已变化。',
  serverDescription: '服务器计时器当前为运行中',
  canRetry: true,
  canSwitchToTimer: true,
};

it('offers adopt, compatible retry, and an explicit non-color explanation', async () => {
  const onAdopt = vi.fn();
  const onRetry = vi.fn();
  const user = userEvent.setup();
  render(<TimerReconciliation model={model}
    onAdopt={onAdopt} onRetry={onRetry} onSwitch={vi.fn()} />);
  expect(screen.getByRole('alert').textContent).toContain('尝试了“暂停”');
  expect(screen.getByRole('alert').textContent).toContain('服务器计时器当前为运行中');
  await user.click(screen.getByRole('button', { name: '重新执行暂停' }));
  expect(onAdopt).not.toHaveBeenCalled();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('guards a deferred retry and disables adopt and switch together', async () => {
  const pending = deferred();
  const onRetry = vi.fn(() => pending.promise);
  render(<TimerReconciliation model={model}
    onAdopt={vi.fn()} onRetry={onRetry} onSwitch={vi.fn()} />);
  const retry = screen.getByRole('button', { name: '重新执行暂停' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', true);
  expect(screen.getByRole('status').textContent).toContain('正在重新执行');
  await act(async () => pending.resolve());
});

it('guards a deferred adopt and reports failure before re-enabling actions', async () => {
  const pending = deferred();
  const onAdopt = vi.fn(() => pending.promise);
  render(<TimerReconciliation model={model}
    onAdopt={onAdopt} onRetry={vi.fn()} onSwitch={vi.fn()} />);
  const adopt = screen.getByRole('button', { name: '采用服务器状态' });
  fireEvent.click(adopt);
  fireEvent.click(adopt);
  expect(onAdopt).toHaveBeenCalledTimes(1);
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', true);
  await act(async () => pending.reject(new Error('本地确认失败')));
  expect((await screen.findByText('本地确认失败')).textContent)
    .toBe('本地确认失败');
  expect(screen.getByRole('button', { name: '采用服务器状态' }))
    .toHaveProperty('disabled', false);
});
