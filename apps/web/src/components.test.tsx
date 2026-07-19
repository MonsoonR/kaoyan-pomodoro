// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { Modal } from './components.jsx';
import { AppSelect } from './components/AppSelect';

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

it('uses the project select menu instead of a native browser select', async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<AppSelect
    label="计时模式"
    value="25-5"
    onChange={onChange}
    options={[
      { value: '25-5', label: '25 / 5' },
      { value: '50-10', label: '50 / 10' },
      { value: 'custom', label: '自定义' },
    ]}
  />);
  expect(screen.queryByRole('combobox')).toBeNull();
  await user.click(screen.getByRole('button', { name: '计时模式' }));
  await user.click(screen.getByRole('option', { name: '50 / 10' }));
  expect(onChange).toHaveBeenCalledWith('50-10');
});
