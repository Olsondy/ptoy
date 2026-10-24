import { ConnectionState, type LocalAudioTrack, Room, RoomEvent, createLocalAudioTrack } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { accessErrorMessage, cancelCall, fetchAttempt, fetchCallToken, InvalidCharacterLink } from './token';

export type CallStatus = 'disconnected' | 'connecting' | 'connected';
export interface CallState { readonly status: CallStatus; readonly room: Room | undefined; readonly error: string | undefined; readonly established: boolean }
const IDLE: CallState = { status: 'disconnected', room: undefined, error: undefined, established: false };
class CallError extends Error {}
interface ActiveCall {
  room: Room; requestId: string; abort: AbortController; attemptId?: string; controlToken?: string; mic?: LocalAudioTrack;
  admitted: boolean; polling: boolean; startedAt: number; pollTimer?: ReturnType<typeof setInterval>;
}
function micErrorMessage(error: unknown): string {
  if (!window.isSecureContext || !navigator.mediaDevices) return '当前页面不是安全连接（HTTPS 或 localhost），浏览器不允许使用麦克风。';
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝。请在浏览器地址栏的网站设置中允许麦克风，然后重新拨打。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风。';
  if (name === 'NotReadableError') return '麦克风被其他程序占用，无法打开。';
  return '无法打开麦克风。';
}

/** Application admission, not just a LiveKit signal connection, establishes a call. */
export function useCall() {
  const [state, setState] = useState<CallState>(IDLE);
  const active = useRef<ActiveCall | undefined>(undefined);
  const accessLost = useRef(false);
  const dispose = useCallback((call: ActiveCall) => {
    clearInterval(call.pollTimer);
    call.abort.abort(); call.mic?.stop();
    // The request ID also cancels requests whose token response was lost or aborted.
    void cancelCall(call.requestId, call.attemptId, call.controlToken).catch(() => { /* Server reconciliation is authoritative. */ });
    void call.room.disconnect();
  }, []);
  const finish = useCallback((call: ActiveCall, error?: string) => {
    if (active.current !== call) return;
    active.current = undefined;
    dispose(call); setState({ ...IDLE, error });
  }, [dispose]);
  const stop = useCallback(() => { if (active.current) finish(active.current); }, [finish]);
  const refreshCall = useCallback(async (call: ActiveCall) => {
    if (active.current !== call || call.polling || !call.attemptId) return;
    call.polling = true;
    try {
      const status = await fetchAttempt(call.attemptId, AbortSignal.any([call.abort.signal, AbortSignal.timeout(10000)]), call.controlToken);
      if (active.current !== call) return;
      if (status === 'ended' || status === 'ending') { finish(call, '这次通话已结束，请重新拨打。'); return; }
      if (status === 'established') call.admitted = true;
      if (accessLost.current && !call.admitted) { finish(call); return; }
      const connected = call.admitted && call.room.state === ConnectionState.Connected;
      setState(prev => ({ ...prev, established: call.admitted, status: connected ? 'connected' : 'connecting' }));
    } catch {
      // An unavailable control API must not hang up an already established call.
      if (active.current === call && !call.admitted && Date.now() - call.startedAt > 70000) finish(call, '连接超时，请稍后重新拨打。');
    } finally { call.polling = false; }
  }, [finish]);
  const resolveAccessLoss = useCallback(() => {
    accessLost.current = true;
    const call = active.current;
    if (!call || call.admitted) return;
    if (!call.attemptId) finish(call);
    else void refreshCall(call);
  }, [finish, refreshCall]);
  const start = useCallback(async (character?: string, characterLink?: string) => {
    if (active.current) return;
    accessLost.current = false;
    const room = new Room();
    const call: ActiveCall = { room, requestId: crypto.randomUUID(), abort: new AbortController(), admitted: false, polling: false, startedAt: Date.now() };
    active.current = call;
    setState({ ...IDLE, status: 'connecting' });
    const isCurrent = () => active.current === call;
    room.on(RoomEvent.ConnectionStateChanged, connection => {
      if (!isCurrent()) return;
      if (connection === ConnectionState.Disconnected) { finish(call, '通话已断开（网络中断或服务不可用）。'); return; }
      setState(prev => ({ ...prev, status: connection === ConnectionState.Connected && call.admitted ? 'connected' : 'connecting' }));
    }).on(RoomEvent.Disconnected, () => { if (isCurrent()) finish(call, '通话已断开（网络中断或服务不可用）。'); });
    try {
      // Unlock playback in the click gesture; request the microphone only after authorization.
      void room.startAudio().catch(() => undefined);
      const token = await fetchCallToken(character, AbortSignal.any([call.abort.signal, AbortSignal.timeout(15000)]), characterLink, call.requestId);
      if (!isCurrent()) return;
      call.attemptId = token.attemptId;
      call.controlToken = token.controlToken;
      try { call.mic = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }); }
      catch (error) { throw new CallError(micErrorMessage(error)); }
      if (!isCurrent()) { call.mic.stop(); return; }
      await room.connect(token.serverUrl, token.participantToken).catch(() => { throw new CallError('无法连接到 LiveKit 服务器。'); });
      if (!isCurrent()) { dispose(call); return; }
      await room.localParticipant.publishTrack(call.mic);
      if (!isCurrent()) { dispose(call); return; }
      setState({ status: 'connecting', room, error: undefined, established: false });
      call.pollTimer = setInterval(() => void refreshCall(call), 750);
      await refreshCall(call);
    } catch (error) {
      if (!isCurrent()) return;
      const message = error instanceof InvalidCharacterLink ? '角色链接无效或已失效，请向分享者获取新链接。'
        : error instanceof CallError ? error.message : accessErrorMessage(error);
      finish(call, message);
    }
  }, [dispose, finish, refreshCall]);
  useEffect(() => {
    const unload = () => { const call = active.current; if (call) { active.current = undefined; dispose(call); } };
    const pagehide = () => { unload(); setState(IDLE); };
    window.addEventListener('pagehide', pagehide);
    return () => { window.removeEventListener('pagehide', pagehide); unload(); };
  }, [dispose]);
  return { ...state, start, stop, resolveAccessLoss };
}
