import { expect, test } from '@playwright/test';

// The echo agent is spawned per call and needs a few seconds to cold-start in dev mode.
const AGENT_JOIN_TIMEOUT = 20_000;

test('call toggle: connect → 通话中 → agent audio → hang up → 已断开', async ({ page }) => {
  await page.goto('/');

  const toggle = page.getByTestId('call-toggle');
  const status = page.getByTestId('call-status');

  await expect(status).toHaveAttribute('data-status', 'disconnected');
  await expect(status).toHaveText('已断开');
  await expect(toggle).toHaveAccessibleName('开始通话');

  await toggle.click();

  await expect(status).toHaveAttribute('data-status', 'connected');
  await expect(status).toHaveText('通话中');
  await expect(toggle).toHaveAccessibleName('挂断');
  await expect(page.getByTestId('call-error')).toHaveCount(0);

  // The agent joining is observable as its echo track being played back on the page.
  const agentAudio = page.locator('audio');
  await expect(agentAudio).toHaveCount(1, { timeout: AGENT_JOIN_TIMEOUT });
  await expect
    .poll(() => agentAudio.evaluate((el: HTMLAudioElement) => !el.paused && el.readyState >= 2), {
      timeout: AGENT_JOIN_TIMEOUT,
    })
    .toBe(true);

  await toggle.click();

  await expect(status).toHaveAttribute('data-status', 'disconnected');
  await expect(status).toHaveText('已断开');
  await expect(toggle).toHaveAccessibleName('开始通话');
  await expect(page.getByTestId('call-error')).toHaveCount(0);
  await expect(agentAudio).toHaveCount(0);
});
