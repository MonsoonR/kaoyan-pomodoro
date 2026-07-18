// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TimerReconciliation } from './TimerReconciliation';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  operationId: 'operation-a',
  operationCreatedAt: '2026-07-13T04:00:00.000Z',
  attemptedAction: '暂停',
  errorCode: 'STALE_TIMER_VERSION',
  explanation: '计时状态已经变化，请确认要保留的内容。',
  serverDescription: '服务器计时器当前为运行中',
  canRetry: true,
  canSwitchToTimer: true,
};

function renderReconciliation(overrides: {
  onAdopt?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  onSwitch?: () => void | Promise<void>;
} = {}) {
  const props = {
    model,
    onAdopt: vi.fn(),
    onRetry: vi.fn(),
    onSwitch: vi.fn(),
    ...overrides,
  };
  return { ...render(<TimerReconciliation {...props} />), props };
}

it('offers adopt, compatible retry, and an explicit non-color explanation', async () => {
  const onAdopt = vi.fn();
  const onRetry = vi.fn();
  const user = userEvent.setup();
  renderReconciliation({ onAdopt, onRetry });
  expect(screen.getByRole('alert').textContent).toContain('尝试了“暂停”');
  expect(screen.getByRole('alert').textContent)
    .not.toContain('STALE_TIMER_VERSION');
  await user.click(screen.getByRole('button', { name: '重新尝试暂停' }));
  expect(onAdopt).not.toHaveBeenCalled();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it('settles a successful retry without allowing the same retry twice', async () => {
  const first = deferred();
  const second = deferred();
  const onRetry = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const { rerender } = renderReconciliation({ onRetry });

  const retry = screen.getByRole('button', { name: '重新尝试暂停' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(onRetry).toHaveBeenCalledTimes(1);
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', true);

  await act(async () => first.resolve());

  expect(screen.queryByText('正在重新执行…')).toBeNull();
  expect(screen.getByRole('button', { name: '已重新尝试，正在更新' }))
    .toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: '保留当前状态' }))
    .toHaveProperty('disabled', false);
  expect(screen.getByRole('button', { name: '切换到当前计时器' }))
    .toHaveProperty('disabled', false);
  fireEvent.click(screen.getByRole('button', {
    name: '已重新尝试，正在更新',
  }));
  expect(onRetry).toHaveBeenCalledTimes(1);

  rerender(<TimerReconciliation
    model={{ ...model, operationId: 'operation-b' }}
    onAdopt={vi.fn()} onRetry={onRetry} onSwitch={vi.fn()}
  />);
  const nextRetry = screen.getByRole('button', { name: '重新尝试暂停' });
  expect(nextRetry).toHaveProperty('disabled', false);
  fireEvent.click(nextRetry);
  expect(onRetry).toHaveBeenCalledTimes(2);
  await act(async () => second.resolve());
});

it('settles a successful switch and permits a subsequent adopt', async () => {
  const pending = deferred();
  const onSwitch = vi.fn(() => pending.promise);
  const onAdopt = vi.fn();
  renderReconciliation({ onAdopt, onSwitch });

  const switchButton = screen.getByRole('button', {
    name: '切换到当前计时器',
  });
  fireEvent.click(switchButton);
  fireEvent.click(switchButton);
  expect(onSwitch).toHaveBeenCalledTimes(1);
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', true);

  await act(async () => pending.resolve());

  expect(screen.queryByText('正在切换…')).toBeNull();
  expect(screen.getByRole('button', { name: '重新尝试暂停' }))
    .toHaveProperty('disabled', false);
  const adopt = screen.getByRole('button', { name: '保留当前状态' });
  expect(adopt).toHaveProperty('disabled', false);
  fireEvent.click(adopt);
  expect(onAdopt).toHaveBeenCalledTimes(1);
});

it('reports a failed switch and restores every legal action', async () => {
  const pending = deferred();
  renderReconciliation({ onSwitch: vi.fn(() => pending.promise) });
  fireEvent.click(screen.getByRole('button', { name: '切换到当前计时器' }));

  await act(async () => pending.reject(new Error('无法切换到服务器计时器')));

  expect(screen.getByText('计时状态暂时无法处理，请重试。')).toBeTruthy();
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', false);
});

it('reports a failed retry and restores every legal action', async () => {
  const pending = deferred();
  renderReconciliation({ onRetry: vi.fn(() => pending.promise) });
  fireEvent.click(screen.getByRole('button', { name: '重新尝试暂停' }));

  await act(async () => pending.reject(new Error('重新提交失败')));

  expect(screen.getByText('计时状态暂时无法处理，请重试。')).toBeTruthy();
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', false);
});

it('keeps a successful adopt submitted until the issue changes', async () => {
  const pending = deferred();
  const next = deferred();
  const onAdopt = vi.fn()
    .mockImplementationOnce(() => pending.promise)
    .mockImplementationOnce(() => next.promise);
  const { rerender } = renderReconciliation({ onAdopt });
  const adopt = screen.getByRole('button', { name: '保留当前状态' });
  fireEvent.click(adopt);

  await act(async () => pending.resolve());

  const submitted = screen.getByRole('button', {
    name: '已保留，正在更新…',
  });
  expect(submitted).toHaveProperty('disabled', true);
  fireEvent.click(submitted);
  expect(onAdopt).toHaveBeenCalledTimes(1);

  rerender(<TimerReconciliation
    model={{ ...model, operationId: 'operation-b' }}
    onAdopt={onAdopt} onRetry={vi.fn()} onSwitch={vi.fn()}
  />);
  const nextAdopt = screen.getByRole('button', { name: '保留当前状态' });
  expect(nextAdopt).toHaveProperty('disabled', false);
  fireEvent.click(nextAdopt);
  expect(onAdopt).toHaveBeenCalledTimes(2);
  await act(async () => next.resolve());
});

it('reports a failed adopt before re-enabling actions', async () => {
  const pending = deferred();
  renderReconciliation({ onAdopt: vi.fn(() => pending.promise) });
  const adopt = screen.getByRole('button', { name: '保留当前状态' });
  fireEvent.click(adopt);
  fireEvent.click(adopt);
  await act(async () => pending.reject(new Error('本地确认失败')));
  expect(screen.getByText('计时状态暂时无法处理，请重试。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '保留当前状态' }))
    .toHaveProperty('disabled', false);
});

it('discards a failed retry from an older issue', async () => {
  const oldRetry = deferred();
  const onRetry = vi.fn(() => oldRetry.promise);
  const { rerender } = renderReconciliation({ onRetry });
  fireEvent.click(screen.getByRole('button', { name: '重新尝试暂停' }));

  rerender(<TimerReconciliation
    model={{ ...model, operationId: 'operation-b' }}
    onAdopt={vi.fn()} onRetry={vi.fn()} onSwitch={vi.fn()}
  />);
  expect(screen.queryByText('旧问题重试失败')).toBeNull();
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', false);

  await act(async () => oldRetry.reject(new Error('旧问题重试失败')));

  expect(screen.queryByText('旧问题重试失败')).toBeNull();
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', false);
});

it('discards a successful switch from an older issue', async () => {
  const oldSwitch = deferred();
  const newAdopt = deferred();
  const onSwitch = vi.fn(() => oldSwitch.promise);
  const { rerender } = renderReconciliation({ onSwitch });
  fireEvent.click(screen.getByRole('button', { name: '切换到当前计时器' }));

  rerender(<TimerReconciliation
    model={{ ...model, operationId: 'operation-b' }}
    onAdopt={() => newAdopt.promise} onRetry={vi.fn()} onSwitch={vi.fn()}
  />);
  fireEvent.click(screen.getByRole('button', { name: '保留当前状态' }));
  await act(async () => oldSwitch.resolve());

  expect(screen.getByRole('button', { name: '正在采用…' }))
    .toHaveProperty('disabled', true);
  for (const button of screen.getAllByRole('button'))
    expect(button).toHaveProperty('disabled', true);
  await act(async () => newAdopt.resolve());
});

it('settles an action after unmount without logging or leaking a rejection', async () => {
  const resolveAfterUnmount = deferred();
  const rejectAfterUnmount = deferred();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const first = renderReconciliation({
    onRetry: vi.fn(() => resolveAfterUnmount.promise),
  });
  fireEvent.click(screen.getByRole('button', { name: '重新尝试暂停' }));
  first.unmount();
  await act(async () => resolveAfterUnmount.resolve());

  const second = renderReconciliation({
    onSwitch: vi.fn(() => rejectAfterUnmount.promise),
  });
  fireEvent.click(screen.getByRole('button', { name: '切换到当前计时器' }));
  second.unmount();
  await act(async () => rejectAfterUnmount.reject(new Error('late failure')));

  expect(consoleError).not.toHaveBeenCalled();
});
