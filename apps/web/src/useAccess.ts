import { useCallback, useEffect, useRef, useState } from 'react';
import { accessErrorMessage, type AccessSession, fetchSession, logoutSession, redeemInvite } from './token';

export function useAccess() {
  const [session, setSession] = useState<AccessSession>();
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const revision = useRef(0);
  const mounted = useRef(true);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const version = ++revision.current;
    try {
      const next = await fetchSession(AbortSignal.timeout(10000));
      if (!mounted.current || version !== revision.current) return;
      setSession(next); setError('');
    } catch (error) {
      if (!mounted.current || version !== revision.current) return;
      setError(accessErrorMessage(error));
    } finally { if (mounted.current && version === revision.current) setChecking(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const focus = () => void refresh();
    const invalid = (event: Event) => {
      ++revision.current;
      setSession({ authenticated: false, code: (event as CustomEvent<string>).detail });
      setChecking(false);
    };
    window.addEventListener('focus', focus);
    window.addEventListener('ptoy:access-invalid', invalid);
    return () => { mounted.current = false; ++revision.current; clearInterval(timer); window.removeEventListener('focus', focus); window.removeEventListener('ptoy:access-invalid', invalid); };
  }, [refresh]);
  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    const timer = setTimeout(() => {
      if (session.expiresAt! > Date.now()) { void refresh(); return; }
      ++revision.current;
      setSession({ authenticated: false, code: 'unauthorized' });
    }, Math.min(2147483647, Math.max(0, session.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [session, refresh]);
  const redeem = useCallback(async (code: string) => {
    mutating.current = true;
    const version = ++revision.current;
    try {
      const next = await redeemInvite(code);
      if (mounted.current && version === revision.current) { setSession(next); setError(''); setChecking(false); }
    } finally { mutating.current = false; }
  }, []);
  const logout = useCallback(async () => {
    mutating.current = true;
    ++revision.current;
    try {
      await logoutSession();
      if (mounted.current) { setSession({ authenticated: false }); setError(''); }
    } finally { mutating.current = false; }
  }, []);
  return { authenticated: session?.authenticated === true, resolved: session !== undefined, checking, error, code: session?.code, refresh, redeem, logout };
}
