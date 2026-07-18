import {
  expect,
  test,
  type Page,
  type TestInfo,
} from '@playwright/test';

const password = 'correct horse battery staple';

function usesCompactNavigation(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1_440) <= 900;
}

async function assertNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    body: document.body.scrollWidth <= document.body.clientWidth,
    document: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }))).toEqual({ body: true, document: true });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await assertNoHorizontalOverflow(page);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
  const needsFullPage = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight + 1,
  );
  if (needsFullPage) {
    const fullPath = testInfo.outputPath(`${name}-full-page.png`);
    await page.screenshot({ path: fullPath, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`${name}-full-page`, { path: fullPath, contentType: 'image/png' });
  }
}

async function login(page: Page) {
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注此刻' })).toBeVisible();
}

async function navigate(
  page: Page,
  label: '专注' | '今日任务' | '任务库' | '学习记录' | '设置' | '邀请管理',
) {
  if (usesCompactNavigation(page)) {
    const navigation = page.getByRole('navigation', { name: '手机导航' });
    if (label === '设置' || label === '邀请管理') {
      await navigation.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('dialog', { name: '更多' })
        .getByRole('button', { name: new RegExp(label === '设置' ? '设置与账号' : '邀请管理') })
        .click();
      return;
    }
    await navigation.getByRole('button', { name: label, exact: true }).click();
    return;
  }
  const navigation = label === '邀请管理'
    ? page.getByRole('navigation', { name: '管理员导航' })
    : page.getByRole('navigation', { name: '主要导航' });
  await navigation.getByRole('button', { name: label, exact: true }).click();
}

async function manualSync(page: Page) {
  const timerSync = page.getByRole('button', { name: /同步计时器|更新计时状态/ });
  if (await timerSync.count()) {
    await expect(timerSync).toBeEnabled();
    await timerSync.click();
    await expect(
      page.getByRole('button', { name: /同步计时器|更新计时状态/ })
        .or(page.getByText('计时器已结束'))
        .or(page.getByText('需要确认计时器状态')),
    ).toBeVisible();
    return;
  }
  const compact = usesCompactNavigation(page);
  if (compact) {
    await page.getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name: '更多', exact: true }).click();
  }
  const status = page.locator(compact
    ? '.mobile-more__sync details.sync-status'
    : '.sidebar-sync details.sync-status');
  await expect(status).toBeVisible();
  if (!(await status.evaluate((element) => element.hasAttribute('open')))) {
    await status.locator('summary').click();
  }
  const button = status.getByRole('button', { name: /立即更新|正在更新/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status.locator('summary')).toContainText('已同步');
  await expect(status.getByRole('button', { name: '立即更新' })).toBeEnabled();
  await status.locator('summary').click();
  await expect(status).not.toHaveAttribute('open', '');
  if (compact) await page.keyboard.press('Escape');
}

test('desktop, tablet and mobile cover all primary pages and functions', async ({ page }, testInfo) => {
  const suffix = `${testInfo.project.name}-${Date.now()}`;
  const taskTitle = `页面覆盖任务 ${suffix}`;
  const renamedDevice = `Playwright ${testInfo.project.name}`;

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /把今天的每一段.*交给专注/ })).toBeVisible();
  await capture(page, testInfo, '01-login');

  await page.getByRole('button', { name: '使用邀请码注册' }).click();
  await expect(page.getByRole('dialog', { name: '使用邀请码注册' })).toBeVisible();
  await capture(page, testInfo, '02-invite-entry');
  await page.keyboard.press('Escape');

  await page.goto('/#/invite/playwright-coverage-invalid-token');
  await expect(page.getByRole('heading', { name: /用一枚邀请.*开启备考节奏/ })).toBeVisible();
  await capture(page, testInfo, '03-invite-registration');
  await page.getByRole('button', { name: '返回登录' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  await login(page);

  await expect(page.getByRole('navigation', {
    name: usesCompactNavigation(page) ? '手机导航' : '主要导航',
  })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1_440) <= 820) {
    const alignment = await page.locator('.editorial-actions').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { actionsCenter: box.left + box.width / 2, viewportCenter: window.innerWidth / 2 };
    });
    expect(Math.abs(alignment.actionsCenter - alignment.viewportCenter)).toBeLessThanOrEqual(1);
  }
  await capture(page, testInfo, '04-focus-home');

  if (usesCompactNavigation(page)) {
    await page.getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name: '更多', exact: true }).click();
    const more = page.getByRole('dialog', { name: '更多' });
    await expect(more.getByRole('button', { name: /数据需要处理/ })).toBeVisible();
    await expect(more.getByRole('button', { name: /邀请管理/ })).toBeVisible();
    await capture(page, testInfo, '05-mobile-more');
    await page.keyboard.press('Escape');
  }

  await navigate(page, '任务库');
  await expect(page.getByRole('heading', { name: '任务库', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建长期任务' }).click();
  await expect(page.getByRole('dialog', { name: '新建长期任务' })).toBeVisible();
  await capture(page, testInfo, '06-library-create-dialog');
  await page.getByLabel('任务名称').fill(taskTitle);
  await page.getByLabel('科目').selectOption('math');
  await page.getByLabel('预计番茄数').fill('3');
  await page.getByLabel('计时模式').selectOption('25-5');
  await page.getByRole('button', { name: '保存任务' }).click();
  const card = page.locator('.template-card').filter({ hasText: taskTitle });
  await expect(card).toBeVisible();
  await manualSync(page);

  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('预计番茄数').fill('4');
  await page.getByRole('button', { name: '保存任务' }).click();
  await expect(card).toContainText('4 个番茄');
  await card.getByRole('button', { name: new RegExp(`归档：${taskTitle}`) }).click();
  await expect(card).toHaveClass(/template-card--archived/);
  await card.getByRole('button', { name: new RegExp(`恢复：${taskTitle}`) }).click();
  await expect(card).not.toHaveClass(/template-card--archived/);
  await card.getByRole('button', { name: '加入今天' }).click();
  await manualSync(page);
  await capture(page, testInfo, '07-library');

  await navigate(page, '今日任务');
  const row = page.locator('.task-row').filter({ hasText: taskTitle });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: new RegExp(`标记完成：${taskTitle}`) }).click();
  await expect(row).toContainText('已完成');
  await manualSync(page);
  await row.getByRole('button', { name: new RegExp(`取消完成：${taskTitle}`) }).click();
  await manualSync(page);
  await expect(row.getByRole('button', { name: new RegExp(`开始专注：${taskTitle}`) })).toBeVisible();
  await capture(page, testInfo, '08-today-tasks');

  await row.getByRole('button', { name: new RegExp(`开始专注：${taskTitle}`) }).click();
  await expect(page.getByRole('heading', { name: taskTitle, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停计时器' })).toBeVisible();
  await capture(page, testInfo, '09-timer-running');
  await page.getByRole('button', { name: '暂停计时器' }).click();
  await expect(page.getByRole('button', { name: '继续计时器' })).toBeVisible();
  await capture(page, testInfo, '10-timer-paused');
  await page.getByRole('button', { name: '继续计时器' }).click();
  await expect(page.getByRole('button', { name: '暂停计时器' })).toBeVisible();
  await page.getByRole('button', { name: '提前退出计时器' }).click();
  await expect(page.getByRole('dialog', { name: '提前退出' })).toBeVisible();
  await capture(page, testInfo, '11-timer-exit-dialog');
  await page.getByRole('radio', { name: '计划调整' }).click();
  await page.getByRole('button', { name: '确认退出' }).click();
  await expect(page.getByRole('button', {
    name: /暂停计时器|继续计时器|提前退出计时器/,
  })).toHaveCount(0);
  await page.getByRole('button', { name: '返回今日任务' }).first().click();
  await manualSync(page);

  await navigate(page, '学习记录');
  await expect(page.getByRole('heading', { name: '专注记录' })).toBeVisible();
  await expect(page.locator('.record-row').filter({ hasText: taskTitle }))
    .toContainText('专注中断');
  await capture(page, testInfo, '12-focus-records');

  await navigate(page, '设置');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '账号与设备' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '数据需要处理' })).toBeVisible();
  await page.getByLabel('默认计时模式').selectOption('50-10');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toBeVisible();

  const rename = page.getByRole('button', { name: /重命名：/ }).first();
  await expect(rename).toBeVisible();
  await rename.click();
  await page.getByLabel('设备名称').fill(renamedDevice);
  await page.locator('.inline-form').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('设备名称已更新。')).toBeVisible();

  await page.getByLabel('当前密码').fill(password);
  await page.getByLabel('新密码', { exact: true }).fill('new password 123');
  await page.getByLabel('确认新密码').fill('different password 123');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的新密码不一致');
  await page.getByLabel('当前密码').fill('');
  await page.getByLabel('新密码', { exact: true }).fill('');
  await page.getByLabel('确认新密码').fill('');
  await capture(page, testInfo, '13-settings-account-conflicts');

  await navigate(page, '邀请管理');
  await expect(page.getByRole('heading', { name: '邀请管理' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '创建邀请' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '设置已保存' })).toHaveCount(0);
  await page.getByLabel('有效期').selectOption('1');
  await page.getByRole('button', { name: '创建邀请链接' }).click();
  const invitation = page.getByRole('dialog', { name: '邀请链接已创建' });
  await expect(invitation).toBeVisible();
  await expect(invitation.getByLabel('邀请链接')).toHaveValue(/#\/invite\//);
  await invitation.getByRole('button', { name: '关闭' }).click();
  const createdInvitation = page.locator('.invite-row').first();
  await expect(createdInvitation).toContainText('可使用');
  page.once('dialog', (dialog) => void dialog.accept());
  await createdInvitation.getByRole('button', { name: '撤销' }).click();
  await expect(createdInvitation).toContainText('已撤销');
  await expect(page.getByRole('button', { name: '创建邀请链接' })).toBeEnabled();
  await capture(page, testInfo, '14-invitation-management');
});
