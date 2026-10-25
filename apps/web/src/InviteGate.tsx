import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Orb } from './orb/Orb';
import { ApiError, accessErrorMessage } from './token';

export function InviteGate({ loading, notice, sessionError, onRetry, onRedeem }: {
  loading: boolean; notice?: string; sessionError?: string; onRetry: () => void; onRedeem: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [adult, setAdult] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
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
    if (pending.current || loading || cooldown || !adult) return;
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
    <section className="invite-gate-content" aria-label="邀请验证">
      <div className="orb-slot" aria-hidden="true"><Orb state="idle" /></div>
      <form className="invite-gate-form" onSubmit={event => void submit(event)} aria-busy={busy || loading}>
        <label className="invite-gate-field-label" htmlFor="invite-code">邀请码</label>
        <Input ref={input} id="invite-code" name="invite-code" value={code} onChange={event => { setCode(event.target.value); setError(''); }}
          maxLength={256} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={busy || loading}
          placeholder="输入或粘贴邀请码" aria-invalid={Boolean(error)} aria-describedby="invite-feedback" />
        <label className="invite-age-consent" htmlFor="invite-adult">
          <Checkbox id="invite-adult" checked={adult} onCheckedChange={value => setAdult(value === true)}
            disabled={busy || loading} aria-describedby="invite-age-note" />
          <span className="invite-age-copy"><span>我已满 18 周岁</span><small id="invite-age-note">内容仅适合成年人。</small></span>
        </label>
        <div id="invite-feedback" className="invite-gate-feedback" aria-live="polite">
          {message && <p role="alert">{message}{cooldown > 0 ? ` ${cooldown} 秒后可重试。` : ''}</p>}
        </div>
        <Button className="invite-gate-submit" type="submit" disabled={busy || loading || cooldown > 0 || !adult || !code.replace(/[\s-]/g, '')}>
          {busy || loading ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {busy ? '正在验证' : loading ? '正在确认' : cooldown ? `${cooldown} 秒后重试` : '进入'}
          {!busy && !loading && !cooldown && <ArrowRight aria-hidden="true" />}
        </Button>
        <Button variant="ghost" type="button" className="invite-gate-help-toggle" aria-expanded={helpOpen} aria-controls="invite-help"
          onClick={() => setHelpOpen(!helpOpen)}>关于邀请码<ChevronDown aria-hidden="true" /></Button>
        <p id="invite-help" className="invite-gate-help" hidden={!helpOpen}>向邀请你的朋友索取。验证后，此浏览器可使用 30 天，换设备可使用同一个码。</p>
        {sessionError && <Button variant="ghost" className="min-h-11" type="button" onClick={onRetry}>重新检查访问资格</Button>}
      </form>
    </section>
  </main>;
}
