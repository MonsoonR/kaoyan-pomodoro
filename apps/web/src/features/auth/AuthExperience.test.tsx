// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncDatabase, type SyncDatabase } from '../../db/database';
import { AppRuntime } from '../../runtime/app-runtime';
import { RuntimeProvider } from '../../runtime/runtime-context';
import {
  AuthRequiredError,
  NetworkError,
  RateLimitedError,
  SyncClientError,
} from '../../sync/errors';
import { SyncStatusStore } from '../../sync/status';
import { session, USER_A } from '../../test/fixtures';
import { AuthExperience } from './AuthExperience';

describe('authentication experience', () => {
  const databases: SyncDatabase[] = [];
  afterEach(async () => {
    for (const database of databases.splice(0))
      await database.deleteDatabaseForTests();
  });

  function setup(loginError?: Error) {
    const database = createSyncDatabase(`auth-ui-${crypto.randomUUID()}`);
    databases.push(database);
    const resumeAfterAuthentication = vi.fn(async () => undefined);
    const api = {
      getCurrentSession: vi.fn(async () => { throw new AuthRequiredError(); }),
      login: vi.fn(async () => {
        if (loginError) throw loginError;
        return session();
      }),
    };
    const runtime = new AppRuntime({
      database,
      api: api as never,
      engine: { status: new SyncStatusStore(), resumeAfterAuthentication } as never,
      scheduler: { start: vi.fn(), stop: vi.fn() },
    });
    return { runtime, api, database, resumeAfterAuthentication };
  }

  it.each([
    [new SyncClientError('INVALID_CREDENTIALS', 'secret'), '用户名或密码错误'],
    [new RateLimitedError(), '登录尝试过于频繁'],
    [new NetworkError(), '网络连接失败'],
  ])('shows safe login feedback for %s', async (error, message) => {
    const { runtime } = setup(error);
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><AuthExperience><p>应用内容</p></AuthExperience></RuntimeProvider>);
    await user.type(await screen.findByLabelText('用户名'), 'learner');
    await user.type(screen.getByLabelText('密码'), 'wrong password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    view.unmount();
    await runtime.closed();
  });

  it('enters the app and resumes synchronization after login', async () => {
    const { runtime, api, resumeAfterAuthentication } = setup();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><AuthExperience><p>应用内容</p></AuthExperience></RuntimeProvider>);
    await user.type(await screen.findByLabelText('用户名'), 'learner');
    await user.type(screen.getByLabelText('密码'), 'secure password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(screen.getByText('应用内容')).toBeTruthy());
    expect(api.login).toHaveBeenCalledWith('learner', 'secure password');
    expect(resumeAfterAuthentication).toHaveBeenCalledTimes(1);
    view.unmount();
    await runtime.closed();
  });

  it('keeps the persisted reauthentication dialog open on Escape', async () => {
    const { runtime, database, api } = setup();
    await database.open();
    await database.setActiveUser(USER_A);
    await database.metadata.update(USER_A, {
      authState: 'required', username: 'learner',
    });
    database.close();
    const user = userEvent.setup();
    const view = render(<RuntimeProvider runtime={runtime}><AuthExperience><p>应用内容</p></AuthExperience></RuntimeProvider>);
    const dialog = await screen.findByRole('dialog', { name: '需要重新登录' });
    const password = screen.getByLabelText('再次输入密码');
    await user.click(password);
    await user.type(password, 'not submitted');
    expect(document.activeElement).toBe(password);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '需要重新登录' })).toBe(dialog);
    expect(document.activeElement).toBe(password);
    expect(api.getCurrentSession).not.toHaveBeenCalled();
    view.unmount();
    await runtime.closed();
  });
});
