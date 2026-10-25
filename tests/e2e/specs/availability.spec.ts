import { test as unauthenticatedTest } from '@playwright/test';
import { test, expect, createTestInvite } from '../access-fixture';

unauthenticatedTest('未验证不探测通话服务，验证成功后才开始检查', async ({ page }) => {
  const invitation = createTestInvite();
  let requests = 0;
  await page.route('**/api/availability', route => {
    requests++;
    return route.fulfill({ json: { available: true } });
  });
  await page.goto('/');
  await expect(page.getByRole('region', { name: '邀请验证' })).toBeVisible();
  expect(requests).toBe(0);
  await page.getByLabel('邀请码', { exact: true }).fill(invitation.code);
  await page.getByRole('checkbox', { name: /我已满 18 周岁/ }).check();
  await page.getByRole('button', { name: '进入', exact: true }).click();
  await expect(page.getByTestId('call-toggle')).toBeEnabled();
  expect(requests).toBeGreaterThan(0);
});

test('服务状态：首次检查、维护、模型离线和网络失败均禁拨，恢复后自动可拨', async ({ page }) => {
  type Response = 'maintenance' | 'models_unavailable' | 'network' | 'available';
  let response: Response = 'maintenance';
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  let tokenRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/token') tokenRequests++; });
  await page.route('**/api/availability', async route => {
    if (first) { first = false; await pending; }
    if (response === 'network') { await route.abort('failed'); return; }
    await route.fulfill({ json: response === 'available' ? { available: true } : { available: false, reason: response } });
  });
  await page.goto('/');
  const toggle = page.getByTestId('call-toggle');
  await expect(page.getByText('正在检查通话服务，请稍候。')).toBeVisible();
  await expect(toggle).toBeDisabled();
  release();
  await expect(page.getByTestId('call-error')).toContainText('服务维护中');
  await expect(toggle).toBeDisabled();
  response = 'models_unavailable';
  await expect(page.getByTestId('call-error')).toContainText('本地模型暂时离线');
  await expect(toggle).toBeDisabled();
  response = 'network';
  await expect(page.getByTestId('call-error')).toContainText('稍后自动重试');
  await expect(toggle).toBeDisabled();
  expect(tokenRequests).toBe(0);
  response = 'available';
  await expect(toggle).toBeEnabled();
  await expect(page.getByTestId('call-error')).toHaveCount(0);
});

test('token签发期间变为维护或模型离线时显示明确错误', async ({ page }) => {
  let code = 'maintenance';
  await page.route('**/api/availability', route => route.fulfill({ json: { available: true } }));
  await page.route('**/api/token', route => route.fulfill({ status: 503, json: { code } }));
  await page.goto('/');
  await page.getByTestId('call-toggle').click();
  await expect(page.getByTestId('call-error')).toHaveText('服务维护中，请稍后再试。');
  await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'disconnected');
  code = 'models_unavailable';
  await page.getByTestId('call-toggle').click();
  await expect(page.getByTestId('call-error')).toHaveText('本地模型暂时离线，请稍后再试。');
  await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'disconnected');
});

test('真实已建立通话遇到维护继续进行，仍可挂断，结束后禁拨', async ({ page, request }) => {
  const endpoint = `http://127.0.0.1:${process.env.E2E_TOKEN_PORT ?? 8730}/internal/ops`;
  const headers = { Authorization: `Bearer ${process.env.ACCESS_INTERNAL_SECRET}` };
  const setMaintenance = async (enabled: boolean) => {
    const response = await request.post(`${endpoint}/maintenance`, { headers, data: { enabled } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    await setMaintenance(false);
    await page.goto('/');
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.locator('audio')).toHaveCount(1);
    const observedMaintenance = page.waitForResponse(async response => response.url().endsWith('/api/availability')
      && (await response.json()).reason === 'maintenance');
    expect(await setMaintenance(true)).toMatchObject({ maintenance: true, activeCount: 1 });
    await observedMaintenance;
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.getByTestId('call-error')).toHaveCount(0);
    const hangup = page.getByRole('button', { name: '挂断', exact: true });
    await expect(hangup).toBeEnabled();
    await hangup.click();
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'disconnected');
    await expect(page.getByTestId('call-error')).toContainText('服务维护中');
    await expect(page.getByTestId('call-toggle')).toBeDisabled();
    await expect.poll(async () => (await (await request.get(`${endpoint}/status`, { headers })).json()).activeCount).toBe(0);
  } finally { await setMaintenance(false); }
});
