import { test, expect } from '@playwright/test';
import { AccessStore } from '../../../apps/agent/src/access/store.js';
import { createTestInvite, verifyContext } from '../access-fixture';

function revoke(id: string) {
  const store = new AccessStore(process.env.E2E_INVITE_DB_PATH!);
  try { store.revokeInvite(id); } finally { store.close(); }
}

test('邀请码入口：未验证不加载角色，错误可改，粘贴验证保留固定链接，刷新记住并可退出', async ({ page, context, browser, baseURL }, testInfo) => {
  const invitation = createTestInvite();
  const helper = await browser.newContext();
  await verifyContext(helper, baseURL!, invitation.code);
  const linkResponse = await helper.request.post(new URL('/api/character-link', baseURL).href, {
    headers: { Origin: new URL(baseURL!).origin }, data: { character: 'xiaoyu' },
  });
  const { characterLink } = await linkResponse.json();
  await helper.close();
  let protectedRequests = 0;
  page.on('request', request => { if (/\/api\/(characters|token)(\?|$)/.test(request.url())) protectedRequests++; });
  await page.goto(`/?character=${characterLink}`);
  await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
  expect(protectedRequests).toBe(0);
  await expect(page.getByTestId('call-toggle')).toHaveCount(0);
  const adult = page.getByRole('checkbox', { name: /我已满 18 周岁/ });
  const enter = page.getByRole('button', { name: '进入', exact: true });
  let redeemRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/invite/redeem') redeemRequests++; });
  await expect(adult).not.toBeChecked();
  await expect(enter).toBeDisabled();
  await page.getByLabel('邀请码', { exact: true }).fill('wrong-code');
  await page.getByLabel('邀请码', { exact: true }).press('Enter');
  // The submit handler must also guard age confirmation, independently of button state.
  await page.locator('form').dispatchEvent('submit');
  expect(redeemRequests).toBe(0);
  await expect(enter).toBeDisabled();
  await adult.focus();
  await page.keyboard.press('Space');
  await expect(adult).toBeChecked();
  await expect(enter).toBeEnabled();
  await adult.uncheck();
  await expect(enter).toBeDisabled();
  await page.getByLabel('邀请码', { exact: true }).press('Enter');
  expect(redeemRequests).toBe(0);
  await page.getByText('我已满 18 周岁', { exact: true }).click();
  await expect(adult).toBeChecked();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('invite-age-desktop.png') });
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邀请码不正确');
  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('invite-error-320.png') });
  await page.getByLabel('邀请码', { exact: true }).fill(` ${invitation.code.toLowerCase().replaceAll('-', ' ')} `);
  await page.getByLabel('邀请码', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name: '和小雨聊聊' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('character')).toBe(characterLink);
  await expect(page.getByTestId('character-picker')).toHaveCount(0);
  const cookies = await context.cookies();
  const session = cookies.find(cookie => cookie.name === 'ptoy_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Lax');
  await page.reload();
  await expect(page.getByRole('heading', { name: '和小雨聊聊' })).toBeVisible();
  await page.getByRole('button', { name: '退出此设备' }).click();
  await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
  await expect(adult).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
});

test('同码两设备：第二处不可抢占，撤销不打断已建立通话，挂断后回到入口', async ({ page, context, browser, baseURL }) => {
  const invitation = createTestInvite();
  await verifyContext(context, baseURL!, invitation.code);
  const other = await browser.newContext({ permissions: ['microphone'] });
  try {
    await verifyContext(other, baseURL!, invitation.code);
    const second = await other.newPage();
    await page.goto('/');
    await second.goto(baseURL!);
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await second.getByTestId('call-toggle').click();
    await expect(second.getByTestId('call-error')).toContainText('此邀请码正在通话');
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    revoke(invitation.id);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(second.getByRole('region', { name: '邀请验证' })).toBeVisible();
    await expect(second.getByRole('alert')).toContainText('邀请已失效');
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.getByRole('button', { name: '退出此设备' })).toBeDisabled();
    await page.getByTestId('call-toggle').click();
    await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('邀请已失效');
  } finally { await other.close(); }
});

test('验证错误：限流倒计时与网络失败可重试且保留输入', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/invite/redeem', route => route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, json: { code: 'rate_limited' } }));
  const input = page.getByLabel('邀请码', { exact: true });
  await input.fill('TEST-CODE');
  await page.getByRole('checkbox', { name: /我已满 18 周岁/ }).check();
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('尝试次数有点多');
  await expect(page.getByRole('button', { name: '进入', exact: true })).toBeEnabled();
  await page.unroute('**/api/invite/redeem');
  await page.route('**/api/invite/redeem', route => route.abort('failed'));
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时连不上');
  await expect(input).toHaveValue('TEST-CODE');
  await expect(page.getByRole('button', { name: '进入', exact: true })).toBeEnabled();
  await page.unroute('**/api/invite/redeem');
  await page.route('**/api/invite/redeem', route => route.fulfill({ status: 403, json: { code: 'invalid_origin' } }));
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('当前访问地址未被服务允许');
  await expect(input).toHaveValue('TEST-CODE');
});

test('浏览器会话凭据消失后，已建立通话仍可查询状态并主动挂断', async ({ page, context, baseURL }) => {
  const invitation = createTestInvite();
  await verifyContext(context, baseURL!, invitation.code);
  await page.goto('/');
  await page.getByTestId('call-toggle').click();
  await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
  await context.clearCookies();
  const statusResponse = page.waitForResponse(response => /\/api\/calls\/[a-f0-9-]+$/.test(response.url()));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await statusResponse).status()).toBe(200);
  await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
  const cancelResponse = page.waitForResponse('**/api/calls/cancel');
  await page.getByTestId('call-toggle').click();
  expect((await cancelResponse).status()).toBe(200);
  await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
});
