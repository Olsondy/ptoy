import {
  ConnectionState,
  type LocalAudioTrack,
  Room,
  RoomEvent,
  createLocalAudioTrack,
} from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCallToken } from './token';

export type CallStatus = 'disconnected' | 'connecting' | 'connected';

export interface CallState {
  readonly status: CallStatus;
  readonly room: Room | undefined;
  readonly error: string | undefined;
}

const IDLE: CallState = { status: 'disconnected', room: undefined, error: undefined };

class CallError extends Error {}

function micErrorMessage(error: unknown): string {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    return '当前页面不是安全连接（HTTPS 或 localhost），浏览器不允许使用麦克风。';
  }
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝。请在浏览器地址栏的网站设置中允许麦克风，然后重新拨打。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return '没有找到可用的麦克风。';
  }
  if (name === 'NotReadableError') {
    return '麦克风被其他程序占用，无法打开。';
  }
  return '无法打开麦克风。';
}

async function openMicrophone(): Promise<LocalAudioTrack> {
  try {
    return await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  } catch (error) {
    throw new CallError(micErrorMessage(error));
  }
}

function mapConnectionState(state: ConnectionState): CallStatus {
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Connecting:
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'connecting';
    default:
      return 'disconnected';
  }
}

/** Owns one LiveKit room per call: start() dials, stop() hangs up, errors land back on 'disconnected'. */
export function useCall() {
  const [state, setState] = useState<CallState>(IDLE);
  const activeRoom = useRef<Room | undefined>(undefined);
  const hangingUp = useRef(false);

  const stop = useCallback(() => {
    const room = activeRoom.current;
    hangingUp.current = true;
    activeRoom.current = undefined;
    setState(IDLE);
    void room?.disconnect();
  }, []);

  const start = useCallback(async () => {
    if (activeRoom.current) return;
    const room = new Room();
    activeRoom.current = room;
    hangingUp.current = false;
    setState({ status: 'connecting', room: undefined, error: undefined });

    const isCurrent = () => activeRoom.current === room;

    const onLost = () => {
      if (!isCurrent()) return;
      activeRoom.current = undefined;
      setState({ ...IDLE, error: hangingUp.current ? undefined : '通话已断开（网络中断或服务不可用）。' });
    };

    room
      .on(RoomEvent.ConnectionStateChanged, (connection: ConnectionState) => {
        if (!isCurrent()) return;
        if (connection === ConnectionState.Disconnected) {
          onLost();
          return;
        }
        setState((prev) => ({ ...prev, status: mapConnectionState(connection) }));
      })
      .on(RoomEvent.Disconnected, onLost);

    let mic: LocalAudioTrack | undefined;
    try {
      // Unlock audio playback inside the click gesture (needed on iOS Safari).
      void room.startAudio();
      mic = await openMicrophone();
      if (!isCurrent()) throw new CallError('');
      const token = await fetchCallToken().catch(() => {
        throw new CallError('无法获取通话凭证，请确认 token 服务已启动。');
      });
      if (!isCurrent()) throw new CallError('');
      await room.connect(token.serverUrl, token.participantToken).catch(() => {
        throw new CallError('无法连接到 LiveKit 服务器。');
      });
      if (!isCurrent()) throw new CallError('');
      await room.localParticipant.publishTrack(mic);
      setState({ status: mapConnectionState(room.state), room, error: undefined });
    } catch (error) {
      mic?.stop();
      const message = error instanceof CallError ? error.message : '通话建立失败。';
      // A failed connect may already have fired onLost; keep the more specific message.
      if (isCurrent() || (!activeRoom.current && !hangingUp.current)) {
        activeRoom.current = undefined;
        setState({ ...IDLE, error: message || undefined });
      }
      await room.disconnect();
    }
  }, []);

  useEffect(() => () => void activeRoom.current?.disconnect(), []);

  return { ...state, start, stop };
}
