import { expect, test } from '@playwright/test';
import { Room as RtcRoom } from '@livekit/rtc-node';
import { AccessToken, RoomAgentDispatch, RoomServiceClient } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';

const serverUrl = process.env.LIVEKIT_URL ?? (process.env.LIVEKIT_SERVER_BIN ? 'ws://localhost:7890' : 'ws://localhost:7880');
const apiKey = process.env.LIVEKIT_API_KEY ?? 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET ?? 'secret';
const characterList = {
  defaultId: 'xiaoyou',
  characters: [
    { id: 'xiaoyou', name: '小友', description: '温柔、随和，认真听你说' },
    { id: 'xiaoyu', name: '小雨', description: '轻松聊聊日常与心事' },
  ],
};

test('角色菜单：键盘选择、焦点恢复、窄屏与保存', async ({ page }, testInfo) => {
  await page.route('**/api/characters', (route) => route.fulfill({ json: characterList }));
  await page.goto('/');
  const picker = page.getByTestId('character-picker');
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByTestId('character-xiaoyu')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAccessibleName('选择角色：小雨');
  await page.reload();
  await expect(picker).toHaveAccessibleName('选择角色：小雨');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('idle-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth;
  })).toBe(true);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('character-mobile.png') });
  await page.keyboard.press('Escape');
  await expect(picker).toBeFocused();
  await expect(page.getByTestId('microphone-toggle')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.getByRole('group', { name: '通话控制' }).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  })).toBe(true);
});

test('通话字幕：流式更新、开关、错误提示及清空', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const roomName = `ui-${randomUUID()}`;
  const callerIdentity = 'ui-caller';
  const service = new RoomServiceClient(serverUrl.replace(/^ws/, 'http'), apiKey, apiSecret);
  // Explicit dispatch prevents the regular echo worker from entering this fixture room.
  await service.createRoom({ name: roomName, agents: [new RoomAgentDispatch({ agentName: 'ui-fixture-manual' })] });
  const agentToken = new AccessToken(apiKey, apiSecret, { identity: 'ui-agent', ttl: '5m' });
  agentToken.kind = 'agent';
  agentToken.attributes = { 'lk.agent.state': 'listening' };
  agentToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canPublishData: true, canSubscribe: true, canUpdateOwnMetadata: true });
  const callerToken = new AccessToken(apiKey, apiSecret, { identity: callerIdentity, ttl: '5m' });
  callerToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canPublishData: true, canSubscribe: true });
  const participantToken = await callerToken.toJwt();
  const peer = new RtcRoom();
  try {
    await peer.connect(serverUrl, await agentToken.toJwt());
    const agent = peer.localParticipant!;
    await page.route('**/api/characters', (route) => route.fulfill({ json: characterList }));
    await page.route('**/api/token', (route) => route.fulfill({
      json: { serverUrl, roomName, participantName: callerIdentity, participantToken },
    }));
    await page.goto('/');
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
    await expect(page.getByTestId('caption-window')).toBeVisible();
    await expect(page.getByTestId('character-picker')).toBeDisabled();
    await expect(page.getByText('在听你说', { exact: true })).toBeVisible();

    // Revisions use a stable segment ID even though their stream IDs change.
    const sendUser = async (text: string) => {
      const writer = await agent.streamText({
        topic: 'lk.transcription', senderIdentity: callerIdentity,
        attributes: { 'lk.segment_id': 'user-1' },
      });
      await writer.write(text);
      await writer.close();
    };
    await sendUser('今天想聊聊');
    await expect(page.getByTestId('user-subtitle')).toHaveText('今天想聊聊');
    const reply = await agent.streamText({ topic: 'lk.transcription', attributes: { 'lk.segment_id': 'agent-1' } });
    await reply.write('好呀，\uFEFF');
    await expect(page.getByTestId('agent-subtitle')).toHaveText('好呀，');
    await reply.write('我在听。慢慢说就好。');
    await reply.close();
    await expect(page.getByTestId('agent-subtitle')).toHaveText('好呀，我在听。慢慢说就好。');
    await sendUser('今天想聊聊下班路上发生的事。');
    await expect(page.getByTestId('user-subtitle')).toHaveText('今天想聊聊下班路上发生的事。');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('connected-desktop.png') });

    const longReply = await agent.streamText({ topic: 'lk.transcription', attributes: { 'lk.segment_id': 'agent-1' } });
    await longReply.write('可以慢慢说，我会认真听。'.repeat(20) + '这是正在说的最后一句。');
    await longReply.close();
    const caption = page.getByTestId('agent-subtitle');
    await expect(caption).toContainText('这是正在说的最后一句。');
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('long-caption-desktop.png') });
    await expect.poll(() => caption.evaluate((element) => {
      const text = element.querySelector('span')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, text.textContent!.length - 1);
      range.setEnd(text, text.textContent!.length);
      const lastCharacter = range.getBoundingClientRect();
      const clip = element.getBoundingClientRect();
      return {
        clipped: element.querySelector('span')!.getBoundingClientRect().height > clip.height,
        latestVisible: lastCharacter.top >= clip.top && lastCharacter.bottom <= clip.bottom + 1,
      };
    })).toEqual({ clipped: true, latestVisible: true });

    await page.getByTestId('captions-toggle').click();
    await expect(page.getByTestId('caption-window')).toBeHidden();
    await agent.setAttributes({ 'ptoy.agent_error': '回应暂时不可用，请稍后再试。', 'ptoy.stt_error': '没听清，再说一次吧。' });
    await expect(page.getByTestId('agent-error')).toBeVisible();
    await expect(page.getByTestId('stt-error')).toBeVisible();
    await agent.sendText('这是最新的回应。', { topic: 'lk.transcription' });
    await page.getByTestId('captions-toggle').click();
    await expect(page.getByTestId('agent-subtitle')).toHaveText('这是最新的回应。');
    await agent.setAttributes({ 'ptoy.agent_error': '', 'ptoy.stt_error': '' });
    await expect(page.getByTestId('transcript-open')).toHaveCount(0);
    await expect(page.getByTestId('microphone-toggle')).toHaveCount(0);
    await expect(page.getByRole('group', { name: '通话控制' }).getByRole('button')).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('connected-mobile.png') });
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('caption-window')).toHaveCount(0);
    await page.getByTestId('call-toggle').click();
    await expect(page.getByTestId('caption-window')).toBeVisible();
    await expect(page.getByTestId('agent-subtitle')).toHaveCount(0);
    await page.getByTestId('call-toggle').click();
    expect(errors).toEqual([]);
  } finally {
    await peer.disconnect();
    await service.deleteRoom(roomName);
  }
});
