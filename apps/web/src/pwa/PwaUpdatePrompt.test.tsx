// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaUpdatePrompt } from './PwaUpdatePrompt';

const updateServiceWorker = vi.fn(() => Promise.resolve());
vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    offlineReady: [false, vi.fn()],
    needRefresh: [true, vi.fn()],
    updateServiceWorker,
  }),
}));

describe('PWA update prompt', () => {
  beforeEach(() => updateServiceWorker.mockClear());
  afterEach(cleanup);

  it('never activates an update until the user explicitly chooses it', () => {
    render(<PwaUpdatePrompt />);
    expect(updateServiceWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '更新并刷新' }));
    expect(updateServiceWorker).toHaveBeenCalledWith(true);
  });

  it('can be dismissed without losing a way to reopen it', () => {
    render(<PwaUpdatePrompt />);
    fireEvent.click(screen.getByRole('button', { name: '稍后' }));
    expect(screen.getByRole('button', { name: '发现新内容' })).toBeTruthy();
  });
});
