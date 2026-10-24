import { expect, test } from '@playwright/test';

test('主页复制角色链接，固定页刷新、拨号与挂断均保持角色，主页选择不被覆盖', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByTestId('character-picker').click();
  await page.getByTestId('character-xiaoyu').click();
  await page.getByTestId('character-link-copy').click();
  await expect(page.getByRole('status')).toHaveText('小雨的链接已复制');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const encoded = new URL(link).searchParams.get('character');
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(encoded).not.toContain('xiaoyu');

  // Keep a different preference on the homepage before following the shared link.
  await page.getByTestId('character-picker').click();
  await page.getByTestId('character-xiaoyou').click();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: '和小雨聊聊' })).toBeVisible();
  await expect(page.getByTestId('character-picker')).toHaveCount(0);
  await expect(page.getByTestId('character-link-copy')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '和小雨聊聊' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ptoy.character'))).toBe('xiaoyou');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('fixed-desktop.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('fixed-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  for (let i = 0; i < 2; i++) {
    const request = page.waitForRequest('**/api/token');
    await page.getByTestId('call-toggle').click();
    expect((await request).postDataJSON()).toEqual({ characterLink: encoded });
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'disconnected');
    await expect(page.getByTestId('character-picker')).toHaveCount(0);
  }
  await page.goto('/');
  await expect(page.getByTestId('character-picker')).toHaveAccessibleName('选择角色：小友');
});

test('加载角色前禁用拨号；无效链接不回退默认角色，隐藏字幕后仍显示错误', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/characters?*', async (route) => {
    await pending;
    await route.continue();
  });
  await page.goto('/?character=invalid');
  await expect(page.getByRole('heading', { name: '正在加载角色' })).toBeVisible();
  await expect(page.getByTestId('call-toggle')).toBeDisabled();
  release();
  await expect(page.getByTestId('call-error')).toContainText('角色链接无效或已失效');
  await page.getByTestId('captions-toggle').click();
  await expect(page.getByTestId('call-error')).toBeVisible();
  await expect(page.getByTestId('character-picker')).toHaveCount(0);
  await expect(page.getByTestId('call-toggle')).toBeDisabled();
  for (const query of ['?character=', '?character=a&character=b']) {
    await page.goto('/' + query);
    await expect(page.getByTestId('call-error')).toContainText('角色链接无效或已失效');
    await expect(page.getByTestId('call-toggle')).toBeDisabled();
  }
});

test('角色服务不可用时显示重试提示并禁止固定页拨号', async ({ page }) => {
  await page.route('**/api/characters?*', (route) => route.fulfill({ status: 503 }));
  await page.goto('/?character=test');
  await expect(page.getByTestId('call-error')).toContainText('请刷新页面重试');
  await expect(page.getByTestId('call-toggle')).toBeDisabled();
});

test('复制失败提供可手动复制的链接，窄屏完整显示；生成失败可重试', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied'); } } });
  });
  await page.goto('/');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route('**/api/character-link', (route) => route.fulfill({ status: 503 }));
  await page.getByTestId('character-link-copy').click();
  await expect(page.getByRole('status')).toHaveText('生成链接失败，请重试');
  await page.unroute('**/api/character-link');
  await page.getByTestId('character-link-copy').click();
  await expect(page.getByRole('status')).toHaveText('链接已生成，请手动复制');
  const link = page.getByRole('link', { name: '固定角色链接' });
  await expect(link).toBeVisible();
  expect(await link.evaluate((el) => {
    const bounds = el.parentElement!.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth;
  })).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('share-mobile.png') });
  await link.click();
  await expect(page.getByRole('heading', { name: '和小友聊聊' })).toBeVisible();
});
