import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Orb } from './orb/Orb';
import { ApiError, accessErrorMessage } from './token';

export function InviteGate({ loading, notice, sessionError, onRetry, onRedeem }: {
  loading: boolean; notice?: string; sessionError?: string; onRetry: () => void; onRedeem: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [retryAt]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || loading || cooldown) return;
    const normalized = code.toUpperCase().replace(/[\s-]/g, '');
    if (!normalized) { setError('请先输入邀请码。'); input.current?.focus(); return; }
    pending.current = true; setBusy(true); setError('');
    try { await onRedeem(normalized); }
    catch (error) {
      setError(accessErrorMessage(error));
      if (error instanceof ApiError && error.status === 429) { setRetryAt(Date.now() + Math.max(1, error.retryAfter) * 1000); setNow(Date.now()); }
      input.current?.focus();
    } finally { pending.current = false; setBusy(false); }
  };
  const message = error || sessionError || notice;
  return <main className="invite-gate">
    <header className="invite-gate-header"><span className="call-wordmark" aria-label="ptoy">ptoy<span>.</span></span></header>
    <section className="invite-gate-content" aria-labelledby="invite-heading">
      <div className="orb-slot"><Orb state="idle" /></div>
      <div className="invite-gate-copy">
        <h1 id="invite-heading">{loading ? '正在确认访问资格' : '很高兴你来'}</h1>
        <p>输入朋友给你的邀请码，就可以开始聊天。</p>
      </div>
      <form className="invite-gate-form" onSubmit={event => void submit(event)} aria-busy={busy || loading}>
        <label htmlFor="invite-code">邀请码</label>
        <Input ref={input} id="invite-code" name="invite-code" value={code} onChange={event => { setCode(event.target.value); setError(''); }}
          maxLength={256} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || loading}
          placeholder="输入邀请码" aria-invalid={Boolean(error)} aria-describedby="invite-help invite-feedback" />
        <div id="invite-feedback" className="invite-gate-feedback" aria-live="polite">
          {message && <p role="alert">{message}{cooldown > 0 ? ` ${cooldown} 秒后可重试。` : ''}</p>}
        </div>
        <Button className="invite-gate-submit" type="submit" disabled={busy || loading || cooldown > 0}>
          {busy || loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {busy ? '正在验证' : loading ? '正在确认' : cooldown ? `${cooldown} 秒后重试` : '验证并进入'}
          {!busy && !loading && !cooldown && <ArrowRight aria-hidden="true" />}
        </Button>
        <p id="invite-help" className="invite-gate-help">此浏览器验证后记住 30 天。换设备可使用同一个码。</p>
        {sessionError && <Button variant="ghost" className="min-h-11" type="button" onClick={onRetry}>重新检查访问资格</Button>}
      </form>
    </section>
  </main>;
}
