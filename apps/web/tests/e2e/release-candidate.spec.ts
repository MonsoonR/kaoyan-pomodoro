import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { UserDataExportSchema } from '@kaoyan/contracts';

const password = 'correct horse battery staple';

async function loginPage(page: Page): Promise<Page> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录你的学习空间' })).toBeVisible();
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天也稳稳推进。' })).toBeVisible();
  return page;
}

async function login(context: BrowserContext): Promise<Page> {
  return loginPage(await context.newPage());
}

async function navigate(
  page: Page,
  label: '首页' | '今日任务' | '任务库' | '专注记录' | '设置',
) {
  if (!(await page.locator('.app-shell').count())) {
    await page.getByRole('button', { name: '返回今日任务', exact: true }).first().click();
  }
  const navigation = page.viewportSize()?.width === 390
    ? page.getByRole('navigation', { name: '手机导航' })
    : page.locator('.sidebar');
  await navigation.getByRole('button', { name: label, exact: true }).click();
}

async function manualSync(page: Page) {
  if (await page.getByRole('button', { name: '同步计时器' }).count()) {
    await page.getByRole('button', { name: '同步计时器' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(
      page.getByRole('button', { name: '同步计时器' })
        .or(page.getByText('计时器已结束'))
        .or(page.getByText('需要确认计时器状态')),
    ).toBeVisible();
    return;
  }
  const selector = page.viewportSize()?.width === 390
    ? '.mobile-sync details.sync-status'
    : '.sidebar-sync details.sync-status';
  const status = page.locator(selector);
  if (!(await status.evaluate((element) => element.hasAttribute('open')))) {
    await status.locator('summary').click();
  }
  const button = status.getByRole('button', { name: /立即同步|同步中/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status.locator('summary')).toContainText('已同步');
}

async function createDailyTask(page: Page, title: string) {
  await navigate(page, '今日任务');
  await page.getByRole('button', { name: '添加今日任务' }).click();
  await page.getByLabel('任务名称').fill(title);
  await page.getByLabel('科目').selectOption('math');
  await page.getByLabel('预计番茄数').fill('2');
  await page.getByLabel('计时模式').selectOption('25-5');
  await page.getByRole('button', { name: '保存任务' }).click();
  await expect(page.locator('.task-row').filter({ hasText: title })).toBeVisible();
  await manualSync(page);
}

async function createLibraryTask(page: Page, title: string) {
  await navigate(page, '任务库');
  await page.getByRole('button', { name: '新建长期任务' }).click();
  await page.getByLabel('任务名称').fill(title);
  await page.getByLabel('科目').selectOption('english');
  await page.getByLabel('预计番茄数').fill('3');
  await page.getByLabel('计时模式').selectOption('25-5');
  await page.getByRole('button', { name: '保存任务' }).click();
  const card = page.locator('.template-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '加入今天' }).click();
  await manualSync(page);
}

async function startTask(page: Page, title: string) {
  await navigate(page, '今日任务');
  await page.locator('.task-row').filter({ hasText: title })
    .getByRole('button', { name: new RegExp(`开始专注：${title}`) }).click();
  await expect(page.getByTestId('timer-id')).toBeVisible();
  await expect(page.getByLabel(/剩余时间/)).toBeVisible();
}

async function assertNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))).toEqual(expect.objectContaining({
    scrollWidth: page.viewportSize()?.width,
    clientWidth: page.viewportSize()?.width,
  }));
}

async function exitTimer(page: Page, reason = '计划调整') {
  await page.getByRole('button', { name: '提前退出计时器' }).click();
  await page.getByRole('radio', { name: reason }).click();
  await page.getByRole('button', { name: '确认退出' }).click();
  await manualSync(page);
  await expect(page.getByTestId('timer-id')).toHaveCount(0);
}

test('desktop and 390px mobile Release Candidate behavior', async ({ browser, context, page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-chromium-390';
  await loginPage(page);

  if (!mobile) {
    const title = `RC 桌面同步任务 ${Date.now()}`;
    await createLibraryTask(page, title);
    await navigate(page, '今日任务');
    await expect(page.locator('.task-row').filter({ hasText: title })).toBeVisible();
    await startTask(page, title);
    await page.getByRole('button', { name: '返回今日任务', exact: true }).click();
    await navigate(page, '首页');
    await expect(page.getByRole('region', { name: '当前活动计时器' })).toBeVisible();

    const response = await page.request.get('/api/export');
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['content-disposition']).toMatch(
      /^attachment; filename="kaoyan-pomodoro-export-[0-9TZ-]+\.json"$/,
    );
    const exported = UserDataExportSchema.parse(await response.json());
    expect(exported.tasks.some((task) => task.title === title)).toBe(true);
    expect(JSON.stringify(exported)).not.toContain('passwordHash');
    expect(JSON.stringify(exported)).not.toContain('tokenHash');

    await navigate(page, '设置');
    await expect(page.getByRole('heading', { name: '账号与设备' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '同步冲突' })).toBeVisible();
    await exitTimer(await (async () => {
      await navigate(page, '首页');
      await page.getByRole('button', { name: '返回当前计时器' }).click();
      return page;
    })());
    return;
  }

  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
  await assertNoPageOverflow(page);
  const longTitle = `超长任务标题${'不会撑破手机页面'.repeat(6)}`;
  await createDailyTask(page, longTitle);
  await expect(page.locator('.task-row').filter({ hasText: longTitle })).toBeVisible();
  await assertNoPageOverflow(page);

  const sync = page.locator('.mobile-sync details.sync-status');
  if (!(await sync.evaluate((element) => element.hasAttribute('open')))) {
    await sync.locator('summary').click();
  }
  await expect(sync.getByRole('button', { name: '立即同步' })).toBeVisible();
  await sync.locator('summary').click();

  await startTask(page, longTitle);
  await page.getByRole('button', { name: '暂停计时器' }).click();
  await manualSync(page);
  await expect(page.getByRole('button', { name: '继续计时器' })).toBeVisible();
  const frozen = await page.getByLabel(/剩余时间/).textContent();
  await page.waitForTimeout(1_100);
  await expect(page.getByLabel(/剩余时间/)).toHaveText(frozen ?? '');
  await page.getByRole('button', { name: '继续计时器' }).click();
  await manualSync(page);
  await expect(page.getByRole('button', { name: '暂停计时器' })).toBeVisible();

  await page.evaluate(() => {
    const notice = document.createElement('div');
    notice.className = 'pwa-notice';
    notice.setAttribute('data-testid', 'rc-pwa-notice');
    notice.innerHTML = '<span>新版本已准备好。当前计时不会被中断。</span><button>稍后</button>';
    document.body.append(notice);
  });
  const overlap = await page.evaluate(() => {
    const notice = document.querySelector('[data-testid="rc-pwa-notice"]')?.getBoundingClientRect();
    const controls = document.querySelector('.focus-actions')?.getBoundingClientRect();
    if (!notice || !controls) return true;
    return !(notice.bottom <= controls.top || notice.top >= controls.bottom);
  });
  expect(overlap).toBe(false);
  await page.locator('[data-testid="rc-pwa-notice"]').evaluate((element) => element.remove());

  await page.getByRole('button', { name: '提前退出计时器' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toBeVisible();
  expect(await modal.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');
  await page.getByRole('button', { name: '确认退出' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '确认退出' })).toBeVisible();
  await page.getByRole('radio', { name: '任务已完成' }).click();
  await page.getByRole('button', { name: '确认退出' }).click();
  await manualSync(page);
  await expect(page.getByTestId('timer-id')).toHaveCount(0);

  const divergenceTitle = `RC 手机分歧 ${Date.now()}`;
  await createDailyTask(page, divergenceTitle);
  await startTask(page, divergenceTitle);
  await manualSync(page);

  const otherContext = await browser.newContext();
  const other = await login(otherContext);
  await manualSync(other);
  await navigate(other, '首页');
  await expect(other.getByRole('region', { name: '当前活动计时器' })).toBeVisible();
  await other.getByRole('button', { name: '返回当前计时器' }).click();

  await context.setOffline(true);
  await page.getByRole('button', { name: '暂停计时器' }).click();
  await expect(page.locator('.focus-actions').getByRole('status'))
    .toContainText('等待同步');
  await exitTimer(other, '临时有事');
  await context.setOffline(false);
  await manualSync(page);
  await expect(page.getByText('计时器已在其他设备结束')).toBeVisible();
  const reconciliation = page.locator('.timer-reconciliation');
  expect(await reconciliation.evaluate((element) =>
    element.scrollWidth <= element.clientWidth)).toBe(true);
  await assertNoPageOverflow(page);
  await page.getByRole('button', { name: '采用服务器状态' }).click();

  await navigate(page, '设置');
  await expect(page.getByRole('heading', { name: '账号与设备' })).toBeVisible();
  await expect(page.getByText('当前密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '同步冲突' })).toBeVisible();
  expect(await page.locator('.conflict-center').evaluate((element) =>
    element.scrollWidth <= element.clientWidth)).toBe(true);
  await assertNoPageOverflow(page);

  await otherContext.close();
});
