// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimerControls } from './TimerControls';

afterEach(cleanup);

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

  it.each(['starting', 'pausing', 'resuming', 'completing', 'exiting'] as const)(
    'disables duplicate controls while %s',
    (state) => {
      render(<TimerControls
        state={state}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onExit={vi.fn()}
      />);
      for (const button of screen.queryAllByRole('button'))
        expect(button).toHaveProperty('disabled', true);
      expect(screen.getByRole('status').textContent).toContain('等待同步');
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
});
