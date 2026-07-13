// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { TimerReconciliation } from './TimerReconciliation';

afterEach(cleanup);

it('offers adopt, compatible retry, and an explicit non-color explanation', async () => {
  const onAdopt = vi.fn();
  const onRetry = vi.fn();
  const user = userEvent.setup();
  render(<TimerReconciliation model={{
    operationId: 'operation',
    operationCreatedAt: '2026-07-13T04:00:00.000Z',
    attemptedAction: '暂停',
    errorCode: 'STALE_TIMER_VERSION',
    explanation: '操作基于旧的计时器版本，服务器状态已变化。',
    serverDescription: '服务器计时器当前为运行中',
    canRetry: true,
    canSwitchToTimer: false,
  }} onAdopt={onAdopt} onRetry={onRetry} onSwitch={vi.fn()} />);
  expect(screen.getByRole('alert').textContent).toContain('尝试了“暂停”');
  expect(screen.getByRole('alert').textContent).toContain('服务器计时器当前为运行中');
  await user.click(screen.getByRole('button', { name: '采用服务器状态' }));
  await user.click(screen.getByRole('button', { name: '重新执行暂停' }));
  expect(onAdopt).toHaveBeenCalledTimes(1);
  expect(onRetry).toHaveBeenCalledTimes(1);
});
