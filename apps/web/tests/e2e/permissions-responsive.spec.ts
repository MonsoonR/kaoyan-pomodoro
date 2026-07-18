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
}

async function loginAsAdmin(page: Page) {
  await page.goto('/');
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '专注此刻' })).toBeVisible();
}

test('administrator and ordinary user permissions render correctly at every viewport', async ({
  browser,
  page,
}, testInfo) => {
  await loginAsAdmin(page);
  const viewport = page.viewportSize() ?? { width: 1_440, height: 1_000 };
  const compact = usesCompactNavigation(page);

  if (viewport.width <= 820) {
    await expect(page.locator('.mobile-sync')).toHaveCount(0);
  } else {
    await expect(page.locator('.sidebar-sync')).toContainText('同步状态');
  }
  await capture(page, testInfo, 'validation-01-home');

  if (viewport.width !== 390) return;

  await page.getByRole('navigation', { name: '手机导航' })
    .getByRole('button', { name: '更多', exact: true }).click();
  const adminMore = page.getByRole('dialog', { name: '更多' });
  await expect(adminMore.getByText('账号与管理', { exact: true })).toBeVisible();
  await expect(adminMore.getByText('管理员', { exact: true })).toBeVisible();
  await expect(adminMore.getByRole('button', { name: /邀请管理/ })).toBeVisible();
  await expect(adminMore.getByText('同步状态', { exact: true })).toBeVisible();
  await capture(page, testInfo, 'validation-02-admin-more');
  await adminMore.getByRole('button', { name: /邀请管理/ }).click();

  await expect(page.getByRole('heading', { name: '邀请管理' })).toBeVisible();
  await page.getByLabel('有效期').selectOption('1');
  await page.getByRole('button', { name: '创建邀请链接' }).click();
  const invitation = page.getByRole('dialog', { name: '邀请链接已创建' });
  const inviteUrl = await invitation.getByLabel('邀请链接').inputValue();
  expect(inviteUrl).toMatch(/#\/invite\//);

  const ordinaryContext = await browser.newContext({
    viewport,
    hasTouch: compact,
    isMobile: viewport.width <= 480,
  });
  const ordinaryPage = await ordinaryContext.newPage();
  try {
    await ordinaryPage.goto(inviteUrl);
    const username = `ordinary-${'long-name-'.repeat(6)}${Date.now()}`.slice(0, 64);
    await ordinaryPage.getByLabel('用户名').fill(username);
    await ordinaryPage.getByLabel(/^密码/).fill(password);
    await ordinaryPage.getByLabel('再次输入密码').fill(password);
    await ordinaryPage.getByRole('button', { name: '完成注册' }).click();
    await expect(ordinaryPage.getByRole('heading', { name: '专注此刻' })).toBeVisible();

    await expect(ordinaryPage.locator('.mobile-sync')).toHaveCount(0);
    await ordinaryPage.getByRole('navigation', { name: '手机导航' })
      .getByRole('button', { name: '更多', exact: true }).click();
    const more = ordinaryPage.getByRole('dialog', { name: '更多' });
    await expect(more.getByText('账号与数据', { exact: true })).toBeVisible();
    await expect(more.getByText(username, { exact: true })).toBeVisible();
    await expect(more.getByText('普通用户', { exact: true })).toHaveCount(0);
    await expect(more.getByRole('button', { name: /邀请管理/ })).toHaveCount(0);
    const layout = await more.locator('.mobile-more__identity').evaluate((identity) => {
      const drawer = identity.closest('.mobile-more')?.getBoundingClientRect();
      const name = identity.querySelector('strong')?.getBoundingClientRect();
      const close = identity.closest('.mobile-more')?.querySelector('header button')?.getBoundingClientRect();
      return {
        drawerRight: drawer?.right ?? 0,
        nameRight: name?.right ?? 0,
        closeRight: close?.right ?? 0,
        nameScrollWidth: identity.querySelector('strong')?.scrollWidth ?? 0,
        nameClientWidth: identity.querySelector('strong')?.clientWidth ?? 0,
      };
    });
    expect(layout.nameRight).toBeLessThanOrEqual(layout.drawerRight - 12);
    expect(layout.closeRight).toBeLessThanOrEqual(layout.drawerRight - 12);
    expect(layout.nameScrollWidth).toBeLessThanOrEqual(layout.nameClientWidth);
    await capture(ordinaryPage, testInfo, 'validation-03-ordinary-user-more');
  } finally {
    await ordinaryContext.close();
  }
});
