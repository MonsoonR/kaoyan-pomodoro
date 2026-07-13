import { expect, test } from '@playwright/test';

const password = 'correct horse battery staple';

test('production PWA reopens offline from IndexedDB without caching API data', async ({ browser }) => {
  const context = await browser.newContext();
  let page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('用户名').fill('learner');
  await page.getByLabel('密码').fill(password);
  const loginResponse = page.waitForResponse((response) => response.url().includes('/api/auth/login'));
  await page.getByRole('button', { name: '登录', exact: true }).click();
  const login = await loginResponse;
  expect(login.status(), await login.text()).toBe(200);
  expect(login.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { name: '今天也稳稳推进。' })).toBeVisible();

  const exported = await page.request.get('/api/export');
  expect(exported.status()).toBe(200);
  expect(exported.headers()['cache-control']).toBe('no-store');
  expect(exported.headers()['content-disposition']).toContain('attachment;');

  await page.locator('.sidebar').getByRole('button', { name: '任务库', exact: true }).click();
  await page.getByRole('button', { name: '新建长期任务' }).click();
  await page.getByLabel('任务名称').fill('PWA 离线副本');
  await page.getByLabel('科目').selectOption('math');
  await page.getByLabel('预计番茄数').fill('2');
  await page.getByRole('button', { name: '保存任务' }).click();
  await expect(page.getByText('PWA 离线副本')).toBeVisible();

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const cachedUrls = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => request.url));
    }
    return urls;
  });
  expect(cachedUrls.some((url) => new URL(url).pathname.startsWith('/api/'))).toBe(false);
  expect(cachedUrls.some((url) => new URL(url).pathname === '/api/export')).toBe(false);

  await context.setOffline(true);
  await page.close();
  page = await context.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '今天也稳稳推进。' })).toBeVisible();
  await page.locator('.sidebar').getByRole('button', { name: '任务库', exact: true }).click();
  await expect(page.getByText('PWA 离线副本')).toBeVisible();

  await page.getByRole('button', { name: '新建长期任务' }).click();
  await page.getByLabel('任务名称').fill('PWA 待同步操作');
  await page.getByLabel('科目').selectOption('english');
  await page.getByLabel('预计番茄数').fill('1');
  await page.getByRole('button', { name: '保存任务' }).click();
  const pendingBefore = await countPending(page);
  expect(pendingBefore).toBeGreaterThan(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await countPending(page)).toBe(pendingBefore);

  await context.setOffline(false);
  await expect.poll(async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    return countPending(page);
  }, { timeout: 30_000 }).toBe(0);
  await expect(page.getByText('PWA 待同步操作')).toBeVisible();
  await context.close();
});

async function countPending(page: import('@playwright/test').Page) {
  return page.evaluate(async () => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('kaoyan-pomodoro-sync-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('operations', 'readonly');
      const rows = transaction.objectStore('operations').getAll();
      rows.onerror = () => reject(rows.error);
      rows.onsuccess = () => resolve(rows.result.filter((row) => row.state === 'pending').length);
    };
  }));
}
