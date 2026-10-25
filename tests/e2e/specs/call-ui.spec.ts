import { expect, test } from '../access-fixture';
import { Room as RtcRoom } from '@livekit/rtc-node';
import { AccessToken, ParticipantInfo_State, RoomAgentDispatch, RoomServiceClient } from 'livekit-server-sdk';
import { createHash } from 'node:crypto';

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
  const service = new RoomServiceClient(serverUrl.replace(/^ws/, 'http'), apiKey, apiSecret);
  let roomName = '';
  let callerIdentity = '';
  let peer = new RtcRoom();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const secret = process.env.ACCESS_INTERNAL_SECRET ?? createHash('sha256').update('ptoy-access-internal-v1\0' + apiSecret).digest('hex');
  const internal = (operation: string) => fetch(`http://127.0.0.1:${process.env.E2E_TOKEN_PORT ?? 8730}/internal/access/${operation}`, {
    method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room: roomName, participant: callerIdentity, agentId: 'ui-agent' }),
  });
  const dial = async () => {
    const response = page.waitForResponse('**/api/token');
    await page.getByTestId('call-toggle').click();
    expect((await response).status()).toBe(200);
    await expect.poll(async () => {
      try { return (await service.getParticipant(roomName, callerIdentity)).state; } catch { return -1; }
    }).toBe(ParticipantInfo_State.ACTIVE);
    expect((await internal('admit')).status).toBe(200);
    heartbeat = setInterval(() => void internal('heartbeat'), 3000);
    await expect(page.getByTestId('call-status')).toHaveAttribute('data-status', 'connected');
  };
  const hangup = async () => {
    await page.getByTestId('call-toggle').click();
    clearInterval(heartbeat);
    await peer.disconnect();
    expect((await internal('finish')).status).toBe(200);
    await service.deleteRoom(roomName);
  };
  try {
    await page.route('**/api/characters', (route) => route.fulfill({ json: characterList }));
    await page.route('**/api/token', async route => {
      const response = await route.fetch();
      const token = await response.json();
      roomName = token.roomName; callerIdentity = token.participantName;
      // Keep the real access reservation; only the voice peer is a deterministic UI fixture.
      await service.createRoom({ name: roomName, agents: [new RoomAgentDispatch({ agentName: 'ui-fixture-manual' })] });
      const agentToken = new AccessToken(apiKey, apiSecret, { identity: 'ui-agent', ttl: '5m' });
      agentToken.kind = 'agent'; agentToken.attributes = { 'lk.agent.state': 'listening' };
      agentToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canPublishData: true, canSubscribe: true, canUpdateOwnMetadata: true });
      peer = new RtcRoom();
      await peer.connect(serverUrl, await agentToken.toJwt());
      await route.fulfill({ response });
    });
    await page.goto('/');
    await dial();
    const agent = peer.localParticipant!;
    await expect(page.getByTestId('caption-window')).toBeHidden();
    const centeredOrb = await page.getByTestId('orb-slot').boundingBox();
    await page.getByTestId('captions-toggle').click();
    await expect(page.getByTestId('caption-window')).toBeVisible();
    const raisedOrb = await page.getByTestId('orb-slot').boundingBox();
    expect(raisedOrb!.y + raisedOrb!.height / 2).toBeLessThan(centeredOrb!.y + centeredOrb!.height / 2);
    await expect(page.getByTestId('character-picker')).toBeDisabled();
    await expect(page.getByText('在听你说', { exact: true })).toHaveClass('sr-only');

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
    await longReply.write('可以慢慢说，我会认真听。'.repeat(60) + '这是正在说的最后一句。');
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

    expect(await caption.evaluate(element => element.clientHeight / parseFloat(getComputedStyle(element).lineHeight))).toBeGreaterThan(5);
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.evaluate(() => {
        const caption = document.querySelector('[data-testid="agent-subtitle"]')!.getBoundingClientRect();
        const orb = document.querySelector('[data-testid="orb-slot"]')!.getBoundingClientRect();
        const footer = document.querySelector('.call-footer')!.getBoundingClientRect();
        return caption.bottom <= footer.top && caption.right <= innerWidth && caption.left >= 0
          && (caption.top >= orb.bottom || caption.left >= orb.right)
          && document.documentElement.scrollHeight <= innerHeight;
      })).toBe(true);
      await expect.poll(() => caption.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`long-caption-${viewport.width}x${viewport.height}.png`) });
    }

    await page.getByTestId('captions-toggle').click();
    await expect(page.getByTestId('caption-window')).toBeHidden();
    await expect.poll(() => page.evaluate(() => {
      const orb = document.querySelector('[data-testid="orb-slot"]')!.getBoundingClientRect();
      const stage = document.querySelector('.call-stage')!.getBoundingClientRect();
      return Math.abs(orb.left + orb.width / 2 - (stage.left + stage.width / 2)) < 1;
    })).toBe(true);
    await agent.setAttributes({ 'ptoy.agent_error': '回应暂时不可用，请稍后再试。', 'ptoy.stt_error': '没听清，再说一次吧。' });
    await expect(page.getByTestId('agent-error')).toBeVisible();
    await expect(page.getByTestId('stt-error')).toBeVisible();
    await agent.sendText('这是最新的回应。', { topic: 'lk.transcription' });
    await page.getByTestId('captions-toggle').click();
    await expect(page.getByTestId('agent-subtitle')).toHaveText('这是最新的回应。');
    await agent.setAttributes({ 'ptoy.agent_error': '', 'ptoy.stt_error': '' });
    await expect(page.getByTestId('transcript-open')).toHaveCount(0);
    await expect(page.getByTestId('microphone-toggle')).toHaveCount(0);
    await expect(page.getByRole('group', { name: '通话控制' }).getByRole('button')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('connected-mobile.png') });
    await hangup();
    await expect(page.getByTestId('caption-window')).toHaveCount(0);
    await dial();
    await expect(page.getByTestId('caption-window')).toBeVisible();
    await expect(page.getByTestId('agent-subtitle')).toHaveCount(0);
    await hangup();
    expect(errors).toEqual([]);
  } finally {
    clearInterval(heartbeat);
    await peer.disconnect();
    if (roomName) await service.deleteRoom(roomName).catch(() => undefined);
  }
});
