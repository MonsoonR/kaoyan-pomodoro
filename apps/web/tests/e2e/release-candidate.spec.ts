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
  await expect(page.getByRole('heading', { name: /把今天的每一段.*交给专注/ })).toBeVisible();
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注此刻' })).toBeVisible();
  return page;
}

async function login(context: BrowserContext): Promise<Page> {
  return loginPage(await context.newPage());
}

async function navigate(
  page: Page,
  label: '专注' | '今日任务' | '任务库' | '学习记录' | '设置',
) {
  if (!(await page.locator('.app-shell').count())) {
    await page.getByRole('button', { name: '返回今日任务', exact: true }).first().click();
  }
  if (page.viewportSize()?.width === 390) {
    const navigation = page.getByRole('navigation', { name: '手机导航' });
    if (label === '设置') {
      await navigation.getByRole('button', { name: '更多', exact: true }).click();
      await page.getByRole('dialog', { name: '更多' })
        .getByRole('button', { name: /设置与账号/ }).click();
      return;
    }
    await navigation.getByRole('button', { name: label, exact: true }).click();
    return;
  }
  await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
}

async function manualSync(page: Page) {
  const timerSync = page.getByRole('button', { name: /同步计时器|更新计时状态/ });
  if (await timerSync.count()) {
    await timerSync
      .evaluate((button: HTMLButtonElement) => button.click());
    await expect(
      page.getByRole('button', { name: /同步计时器|更新计时状态/ })
        .or(page.getByText('计时器已结束'))
        .or(page.getByText('需要确认计时器状态')),
    ).toBeVisible();
    return;
  }
  const compact = page.viewportSize()?.width === 390;
  if (compact) {
    await page.getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name: '更多', exact: true }).click();
  }
  const selector = compact
    ? '.mobile-more__sync details.sync-status'
    : '.sidebar-sync details.sync-status';
  const status = page.locator(selector);
  if (!(await status.evaluate((element) => element.hasAttribute('open')))) {
    await status.locator('summary').click();
  }
  const button = status.getByRole('button', { name: /立即更新|正在更新/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status.locator('summary')).toContainText('已同步');
  if (compact) await page.keyboard.press('Escape');
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
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel(/剩余时间/)).toBeVisible();
}

async function expectNoActiveTimer(page: Page) {
  await expect(page.getByRole('button', {
    name: /暂停计时器|继续计时器|提前退出计时器/,
  })).toHaveCount(0);
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
  await expectNoActiveTimer(page);
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
  await navigate(page, '专注');
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
    await expect(page.getByRole('heading', { name: '数据需要处理' })).toBeVisible();
    expect(await page.getByLabel('默认计时模式').evaluate((element) => {
      const style = getComputedStyle(element);
      return { appearance: style.appearance, backgroundImage: style.backgroundImage, fontSize: style.fontSize, borderRadius: style.borderRadius };
    })).toEqual(expect.objectContaining({ appearance: 'none', fontSize: '15px', borderRadius: '8px' }));
    expect(await page.getByLabel('默认计时模式').evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe('none');
    expect(await page.getByLabel('完成提示音').evaluate((element) => getComputedStyle(element).appearance)).toBe('none');
    await exitTimer(await (async () => {
  await navigate(page, '专注');
      await page.getByRole('button', { name: '打开计时' }).click();
      return page;
    })());
    return;
  }

  await expect(page.getByRole('navigation', { name: '手机导航' })).toBeVisible();
  const mobileNavigation = page.getByRole('navigation', { name: '手机导航' });
  await expect(mobileNavigation.getByRole('button')).toHaveCount(5);
  await mobileNavigation.getByRole('button', { name: '更多', exact: true }).click();
  const moreDialog = page.getByRole('dialog', { name: '更多' });
  await expect(moreDialog.getByRole('button', { name: /设置与账号/ })).toBeVisible();
  await expect(moreDialog.getByRole('button', { name: /数据需要处理/ })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  await page.keyboard.press('Escape');
  await expect(moreDialog).toHaveCount(0);
  await expect(mobileNavigation.getByRole('button', { name: '更多', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
  await assertNoPageOverflow(page);
  const longTitle = `超长任务标题${'不会撑破手机页面'.repeat(6)}`;
  await createDailyTask(page, longTitle);
  await expect(page.locator('.task-row').filter({ hasText: longTitle })).toBeVisible();
  await assertNoPageOverflow(page);

  await mobileNavigation.getByRole('button', { name: '更多', exact: true }).click();
  const sync = page.locator('.mobile-more__sync details.sync-status');
  if (!(await sync.evaluate((element) => element.hasAttribute('open')))) {
    await sync.locator('summary').click();
  }
  await expect(sync.getByRole('button', { name: '立即更新' })).toBeVisible();
  await sync.locator('summary').click();
  await page.keyboard.press('Escape');

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
    notice.innerHTML = '<span>新内容已准备好。当前计时不会中断。</span><button>稍后</button>';
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
  await expectNoActiveTimer(page);

  const divergenceTitle = `RC 手机分歧 ${Date.now()}`;
  await createDailyTask(page, divergenceTitle);
  await startTask(page, divergenceTitle);
  await manualSync(page);

  const otherContext = await browser.newContext();
  const other = await login(otherContext);
  await manualSync(other);
  await navigate(other, '专注');
  await expect(other.getByRole('region', { name: '当前活动计时器' })).toBeVisible();
  await other.getByRole('button', { name: '打开计时' }).click();

  await context.setOffline(true);
  await page.getByRole('button', { name: '暂停计时器' }).click();
  await expect(page.locator('.focus-actions').getByRole('status'))
    .toContainText('正在暂停');
  await exitTimer(other, '临时有事');
  await context.setOffline(false);
  await manualSync(page);
  await expect(page.getByRole('alert')).toContainText('这个计时已经结束。');
  const reconciliation = page.locator('.timer-reconciliation');
  expect(await reconciliation.evaluate((element) =>
    element.scrollWidth <= element.clientWidth)).toBe(true);
  await assertNoPageOverflow(page);
  await page.getByRole('button', { name: '保留当前状态' }).click();

  await navigate(page, '设置');
  await expect(page.getByRole('heading', { name: '账号与设备' })).toBeVisible();
  await expect(page.getByText('当前密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '数据需要处理' })).toBeVisible();
  expect(await page.getByLabel('当前密码').evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');
  expect(await page.getByLabel('默认计时模式').evaluate((element) => getComputedStyle(element).backgroundImage)).not.toBe('none');
  expect(await page.getByLabel('完成提示音').evaluate((element) => getComputedStyle(element).appearance)).toBe('none');
  expect(await page.locator('.conflict-center').evaluate((element) =>
    element.scrollWidth <= element.clientWidth)).toBe(true);
  await assertNoPageOverflow(page);

  await otherContext.close();
});
