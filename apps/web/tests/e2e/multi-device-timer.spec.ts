import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const password = 'correct horse battery staple';

async function login(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注此刻' })).toBeVisible();
  return page;
}

async function navigate(page: Page, label: '专注' | '今日任务' | '任务库' | '学习记录') {
  if (!(await page.locator('.sidebar').count()))
    await page.getByRole('button', { name: '返回今日任务', exact: true }).first().click();
  await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
}

async function manualSync(page: Page) {
  if (!(await page.getByRole('button', { name: '同步计时器' }).count()) &&
      !(await page.locator('.sidebar-sync').count())) {
    await page.getByRole('button', { name: '返回今日任务', exact: true }).first().click();
  }
  if (await page.getByRole('button', { name: '同步计时器' }).count()) {
    await page.getByRole('button', { name: '同步计时器' })
      .evaluate((button: HTMLButtonElement) => button.click());
    const busyOrEnded = page.getByRole('button', { name: '计时器同步中…' })
      .or(page.getByText('计时器已结束'));
    await expect(busyOrEnded).toBeVisible();
    await expect(
      page.getByRole('button', { name: '同步计时器' })
        .or(page.getByText('计时器已结束'))
        .or(page.getByText('需要确认计时器状态')),
    ).toBeVisible();
    return;
  }
  const status = page.locator('.sidebar-sync details.sync-status');
  if (!(await status.evaluate((element) => element.hasAttribute('open'))))
    await status.locator('summary').click();
  const button = status.getByRole('button', { name: /立即同步|同步中/ });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status.locator('summary')).toContainText('已同步');
  await expect(status.getByRole('button', { name: '立即同步' })).toBeEnabled();
}

async function createLibraryTask(page: Page, title: string) {
  await navigate(page, '任务库');
  await page.getByRole('button', { name: '新建长期任务' }).click();
  await page.getByLabel('任务名称').fill(title);
  await page.getByLabel('科目').selectOption('math');
  await page.getByLabel('预计番茄数').fill('4');
  await page.getByLabel('计时模式').selectOption('25-5');
  await page.getByRole('button', { name: '保存任务' }).click();
  const card = page.locator('.template-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '加入今天' }).click();
  await manualSync(page);
}

async function createDailyTask(page: Page, title: string) {
  await navigate(page, '今日任务');
  await page.getByRole('button', { name: '添加今日任务' }).click();
  await page.getByLabel('任务名称').fill(title);
  await page.getByLabel('科目').selectOption('math');
  await page.getByLabel('预计番茄数').fill('4');
  await page.getByLabel('计时模式').selectOption('25-5');
  await page.getByRole('button', { name: '保存任务' }).click();
  await manualSync(page);
}

async function startTask(page: Page, title: string) {
  await navigate(page, '今日任务');
  const row = page.locator('.task-row').filter({ hasText: title });
  await row.getByRole('button', { name: new RegExp(`开始专注：${title}`) }).click();
  await expect(page.getByTestId('timer-id')).toBeVisible();
}

async function exitTimer(page: Page, reason = '计划调整') {
  await page.getByRole('button', { name: '提前退出计时器' }).click();
  await page.getByRole('radio', { name: reason }).click();
  await page.getByRole('button', { name: '确认退出' }).click();
  await manualSync(page);
}

test('two isolated devices share, race, and reconcile one global timer', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const deviceA = await login(contextA);
  const deviceB = await login(contextB);
  expect((await contextA.cookies())[0]?.value).not.toBe((await contextB.cookies())[0]?.value);

  await test.step('Flow 1: shared timer controls and one interrupted session', async () => {
    await createLibraryTask(deviceA, '线性代数共享计时');
    await manualSync(deviceB);
    await navigate(deviceB, '今日任务');
    await expect(deviceB.locator('.task-row').filter({
      hasText: '线性代数共享计时',
    })).toBeVisible();

    await startTask(deviceA, '线性代数共享计时');
    const timerId = await deviceA.getByTestId('timer-id').textContent();
    await manualSync(deviceB);
  await navigate(deviceB, '专注');
    await expect(deviceB.getByRole('region', { name: '当前活动计时器' })).toBeVisible();
    await deviceB.getByRole('button', { name: '打开计时' }).click();
    await expect(deviceB.getByTestId('timer-id')).toHaveText(timerId ?? '');

    await deviceB.getByRole('button', { name: '暂停计时器' }).click();
    await manualSync(deviceB);
    await manualSync(deviceA);
    await expect(deviceA.getByRole('button', { name: '继续计时器' })).toBeVisible();
    const frozen = await deviceA.getByLabel(/剩余时间/).textContent();
    await manualSync(deviceA);
    await expect(deviceA.getByLabel(/剩余时间/)).toHaveText(frozen ?? '');

    await deviceA.getByRole('button', { name: '继续计时器' }).click();
    await manualSync(deviceA);
    await manualSync(deviceB);
    await expect(deviceB.getByRole('button', { name: '暂停计时器' })).toBeVisible();

    await exitTimer(deviceB);
    await manualSync(deviceA);
    await expect(deviceA.getByTestId('timer-id')).toHaveCount(0);
  await navigate(deviceA, '学习记录');
  await navigate(deviceB, '学习记录');
    await manualSync(deviceA);
    await manualSync(deviceB);
    await expect(deviceA.getByText('专注中断')).toHaveCount(1);
    await expect(deviceB.getByText('专注中断')).toHaveCount(1);
  });

  await test.step('Flow 2: simultaneous starts converge to one timer', async () => {
    await createDailyTask(deviceA, '并发任务 A');
    await createDailyTask(deviceA, '并发任务 B');
    await manualSync(deviceB);
    await navigate(deviceA, '今日任务');
    await navigate(deviceB, '今日任务');
    const rowA = deviceA.locator('.task-row').filter({ hasText: '并发任务 A' });
    const rowB = deviceB.locator('.task-row').filter({ hasText: '并发任务 B' });
    await Promise.all([
      rowA.getByRole('button', { name: /开始专注：并发任务 A/ }).click(),
      rowB.getByRole('button', { name: /开始专注：并发任务 B/ }).click(),
    ]);
    await Promise.all([
      expect(deviceA.getByTestId('timer-id')).toBeVisible(),
      expect(deviceB.getByTestId('timer-id')).toBeVisible(),
    ]);
    await manualSync(deviceA);
    await manualSync(deviceB);
    const idA = await deviceA.getByTestId('timer-id').textContent();
    const idB = await deviceB.getByTestId('timer-id').textContent();
    expect(idA).toBeTruthy();
    expect(idB).toBe(idA);
    const active = await deviceA.evaluate(async () =>
      (await fetch('/api/timer')).json() as Promise<{ timer: { id: string } | null }>);
    expect(active.timer?.id).toBe(idA);
    await expect.poll(async () =>
      await deviceA.getByText('需要确认计时器状态').count() +
      await deviceB.getByText('需要确认计时器状态').count(),
    ).toBe(1);
    const loser = await deviceA.getByText('需要确认计时器状态').count()
      ? deviceA
      : deviceB;
    const winner = loser === deviceA ? deviceB : deviceA;
    await loser.getByRole('button', { name: '采用服务器状态' }).click();
    await exitTimer(winner, '任务已完成');
    await manualSync(loser);
    await expect(loser.getByTestId('timer-id')).toHaveCount(0);
  });

  await test.step('Flow 3: offline stale pause reconciles after remote exit', async () => {
    await createDailyTask(deviceB, '离线分歧任务');
    await manualSync(deviceA);
    await startTask(deviceB, '离线分歧任务');
    await manualSync(deviceA);
  await navigate(deviceA, '专注');
    await deviceA.getByRole('button', { name: '打开计时' }).click();
    await contextA.setOffline(true);
    await deviceA.getByRole('button', { name: '暂停计时器' }).click();
    await expect(deviceA.locator('.focus-actions').getByRole('status'))
      .toContainText('等待同步');
    await exitTimer(deviceB, '临时有事');
    await contextA.setOffline(false);
    await manualSync(deviceA);
    await expect(deviceA.getByText('计时器已在其他设备结束')).toBeVisible();
    await deviceA.getByRole('button', { name: '采用服务器状态' }).click();
    await expect(deviceA.getByTestId('timer-id')).toHaveCount(0);
  await navigate(deviceA, '学习记录');
    await manualSync(deviceA);
    const taskRows = deviceA.locator('.record-row').filter({ hasText: '离线分歧任务' });
    await expect(taskRows).toHaveCount(1);
  });

  await contextA.close();
  await contextB.close();
});
