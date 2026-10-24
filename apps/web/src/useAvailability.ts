import { useEffect, useState } from 'react';
import { fetchAvailability, type Availability } from './token';

type State = Availability | { available: false; reason: 'checking' | 'network' };
const INITIAL: State = { available: false, reason: 'checking' };

/** Readiness only gates a new dial; it never changes the lifecycle of an active call. */
export function useAvailability(authenticated: boolean) {
  const [state, setState] = useState<State>(INITIAL);
  useEffect(() => {
    setState(INITIAL);
    if (!authenticated) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await fetchAvailability(AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]));
        if (!abort.signal.aborted) setState(next);
      } catch {
        if (!abort.signal.aborted) setState({ available: false, reason: 'network' });
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [authenticated]);
  const reason = state.available ? undefined : state.reason;
  const error = reason === 'maintenance' ? '服务维护中，恢复后即可开始通话。'
    : reason === 'models_unavailable' ? '本地模型暂时离线，恢复后即可开始通话。'
      : reason === 'network' ? '暂时无法确认通话服务，稍后自动重试。' : undefined;
  return { available: authenticated && state.available, error, checking: reason === 'checking' };
}
