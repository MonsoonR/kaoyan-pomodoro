// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Modal } from './components.jsx';

it('uses the latest dismissibility without restarting the modal focus lifecycle', async () => {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <Modal
      open
      title="需要重新登录"
      dismissible
      onClose={() => onClose()}
    >
      <label>密码<input type="password" /></label>
    </Modal>,
  );
  const password = screen.getByLabelText('密码');
  await user.click(password);
  await user.type(password, 'still focused');
  expect(document.activeElement).toBe(password);
  view.rerender(
    <Modal
      open
      title="需要重新登录"
      dismissible={false}
      onClose={() => onClose()}
    >
      <label>密码<input type="password" /></label>
    </Modal>,
  );
  expect(document.activeElement).toBe(password);
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(password);
});
