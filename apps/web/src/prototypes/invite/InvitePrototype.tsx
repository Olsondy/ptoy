import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, KeyRound, LoaderCircle, RotateCcw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Orb } from '../../orb/Orb';
import { CharacterPicker } from '../../CharacterPicker';
import { CaptionsToggle } from '../../CaptionsToggle';
import { CallControls } from '../../CallControls';

const DEMO_CODE = '7K2M-9Q4R-X6WP-3T8N';
const STORAGE_KEY = 'ptoy.prototype.invite.expiresAt';
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const normalize = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
type Scenario = 'normal' | 'invalid' | 'revoked' | 'limited' | 'offline';
type State = 'idle' | 'checking' | 'success' | 'error';
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'normal', label: '正常验证' }, { id: 'invalid', label: '邀请码错误' },
  { id: 'revoked', label: '邀请已撤销' }, { id: 'limited', label: '尝试过多' },
  { id: 'offline', label: '网络异常' },
];
const ERROR_COPY: Record<Exclude<Scenario, 'normal'>, string> = {
  invalid: '邀请码不正确，请检查后再试。',
  revoked: '这个邀请已失效，请联系邀请你的朋友。',
  limited: '尝试次数有点多，请 60 秒后再试。',
  offline: '暂时连不上，请检查网络后重试。',
};
const CHARACTERS = [
  { id: 'demo-a', name: '小雨', description: '原型示例角色' },
  { id: 'demo-b', name: '小友', description: '原型示例角色' },
];

function hasSession() {
  try { return Number(localStorage.getItem(STORAGE_KEY)) > Date.now(); }
  catch { return false; }
}

export function InvitePrototype() {
  const [authorized, setAuthorized] = useState(hasSession);
  const [state, setState] = useState<State>('idle');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scenario, setScenario] = useState<Scenario>('normal');
  const [locked, setLocked] = useState(true);
  const [selectedId, setSelectedId] = useState('demo-a');
  const [captions, setCaptions] = useState(true);
  const [inCall, setInCall] = useState(false);
  const [pendingAccessNotice, setPendingAccessNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = state === 'checking' || state === 'success';
  const name = CHARACTERS.find((character) => character.id === selectedId)!.name;

  const cancelTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => {
      setCooldown((value) => value - 1);
      if (cooldown === 1) setError('现在可以重新验证邀请码。');
    }, 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => {
    if (authorized) heading.current?.focus();
  }, [authorized]);

  const clearSession = (message = '') => {
    cancelTimers();
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Preview works without storage. */ }
    setAuthorized(false); setInCall(false); setCode(''); setState('idle');
    setError(''); setCooldown(0); setNotice(message);
    setPendingAccessNotice('');
  };
  const changeAccess = (message: string, next: Scenario) => {
    setScenario(next);
    if (inCall) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Preview-only storage. */ }
      setPendingAccessNotice(message);
    } else clearSession(message);
  };
  const toggleCall = () => {
    if (inCall && pendingAccessNotice) clearSession(pendingAccessNotice);
    else setInCall(!inCall);
  };
  const changeScenario = (next: Scenario) => {
    clearSession(); setScenario(next);
  };
  const fillCode = () => {
    setCode(DEMO_CODE); setError(''); setState('idle'); input.current?.focus();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || cooldown) return;
    if (!normalize(code)) {
      setState('error'); setError('请先输入邀请码。'); input.current?.focus(); return;
    }
    setError(''); setNotice(''); setState('checking');
    timers.current.push(setTimeout(() => {
      const outcome = normalize(code) !== normalize(DEMO_CODE) ? 'invalid' : scenario;
      if (outcome !== 'normal') {
        setState('error'); setError(ERROR_COPY[outcome]);
        if (outcome === 'limited') setCooldown(60);
        input.current?.focus(); return;
      }
      setState('success');
      timers.current.push(setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, String(Date.now() + THIRTY_DAYS)); }
        catch { /* Only the preview's remembered access is lost. */ }
        setAuthorized(true); setState('idle');
      }, 650));
    }, 850));
  };

  return <TooltipProvider>
    <div className="invite-prototype">
      <main className="invite-preview" aria-label="邀请码交互预览">
        <header className="call-header invite-header">
          <span className="call-wordmark" aria-label="ptoy">ptoy<span>.</span></span>
          {authorized ? <p className="call-status" aria-live="polite">
            <span className={`dot dot-${inCall ? 'connected' : 'disconnected'}`} aria-hidden="true" />
            {inCall ? '通话演示中' : '已断开'}
          </p> : <span />}
          <div className="call-header-actions">
            {authorized ? <>
              {!locked && <CharacterPicker options={CHARACTERS} selectedId={selectedId} select={setSelectedId}
                disabled={inCall} characterLink={undefined} locked={false} loading={false} error={undefined} />}
              <CaptionsToggle visible={captions} onVisibleChange={setCaptions} />
            </> : <span className="invite-private"><KeyRound aria-hidden="true" />朋友试用</span>}
          </div>
        </header>

        {!authorized ? <section className="invite-entry" aria-labelledby="invite-title">
          <div className="invite-orb" aria-hidden="true"><Orb state={state === 'checking' ? 'thinking' : 'idle'} /></div>
          <h1 id="invite-title">很高兴你来</h1>
          <p className="invite-description">输入朋友发给你的邀请码，<br />就可以开始聊天。</p>
          <form className="invite-form" onSubmit={submit} noValidate aria-busy={busy}>
            <label htmlFor="invite-code">邀请码</label>
            <Input ref={input} id="invite-code" name="invite-code" className="invite-code"
              placeholder="输入或粘贴邀请码" autoComplete="off" autoCapitalize="characters" spellCheck={false}
              maxLength={64} value={code} disabled={busy} aria-invalid={state === 'error'}
              aria-describedby="invite-feedback invite-remember" onChange={(event) => {
                setCode(event.target.value); if (state === 'error' && !cooldown) { setState('idle'); setError(''); }
              }} />
            <div id="invite-feedback" className="invite-feedback" aria-live="polite">
              {error && <p className="invite-error" role="alert">{cooldown ? `尝试次数有点多，请 ${cooldown} 秒后再试。` : error}</p>}
              {!error && notice && <p>{notice}</p>}
              {state === 'success' && <p className="invite-success"><Check aria-hidden="true" />验证成功，欢迎你</p>}
            </div>
            <Button type="submit" className="invite-submit" disabled={busy || cooldown > 0}>
              {state === 'checking' ? <><LoaderCircle className="animate-spin" aria-hidden="true" />正在验证</>
                : state === 'success' ? <><Check aria-hidden="true" />验证成功</>
                  : cooldown ? `${cooldown} 秒后重试` : <>验证并进入<ArrowRight aria-hidden="true" /></>}
            </Button>
            <p id="invite-remember" className="invite-remember"><ShieldCheck aria-hidden="true" />此浏览器会记住你 30 天</p>
          </form>
          <p className="invite-help">没有邀请码？问问邀请你的朋友。</p>
        </section> : <>
          <section className="call-stage" aria-labelledby="welcome-title">
            <div className="orb-slot"><Orb state={inCall ? 'speaking' : 'idle'} simulateAudio={inCall} /></div>
            <div className="call-conversation">
              <div className="call-welcome">
                <h1 ref={heading} id="welcome-title" tabIndex={-1}>{inCall ? `${name}正在说话` : locked ? `和${name}聊聊` : '想聊点什么？'}</h1>
                <p className="welcome-description">{inCall ? '这是界面演示，不会打开麦克风' : '不必想好开场，随时开始就好'}</p>
                {inCall && captions && <p className="invite-demo-caption">「今天过得怎么样？」</p>}
              </div>
            </div>
          </section>
          <CallControls status={inCall ? 'connected' : 'disconnected'} error={undefined} onToggle={toggleCall} />
        </>}
      </main>

      <aside className="invite-review" aria-label="原型审查工具">
        <div className="invite-review-heading"><h2>邀请码原型</h2><span>待审查</span></div>
        <p className="invite-review-intro">这里的操作仅用于演示。<br />不连接模型，也不发起真实通话。</p>
        <section className="invite-review-section" aria-labelledby="entry-label">
          <h3 id="entry-label">朋友打开的入口</h3>
          <div className="invite-review-options">
            <Button variant={locked ? 'secondary' : 'ghost'} aria-pressed={locked} onClick={() => { setLocked(true); setSelectedId('demo-a'); setInCall(false); }}>固定角色链接</Button>
            <Button variant={!locked ? 'secondary' : 'ghost'} aria-pressed={!locked} onClick={() => { setLocked(false); setInCall(false); }}>主页</Button>
          </div>
          <p>{locked ? '验证后进入小雨的通话页，不能切换角色。' : '验证后进入主页，可以选择角色。'}</p>
        </section>
        <section className="invite-review-section" aria-labelledby="demo-label">
          <h3 id="demo-label">试用这个演示码</h3>
          <code className="invite-demo-code">{DEMO_CODE}</code>
          <Button variant="outline" className="invite-fill" disabled={authorized || busy || cooldown > 0} onClick={fillCode}>填入演示码<ArrowRight aria-hidden="true" /></Button>
          <p>每人一个，可重复验证。刷新可体验记住访问的效果。</p>
        </section>
        <section className="invite-review-section" aria-labelledby="states-label">
          <h3 id="states-label">验证结果</h3>
          <div className="invite-scenarios">{SCENARIOS.map(({ id, label }) =>
            <Button key={id} variant={scenario === id ? 'secondary' : 'ghost'} aria-pressed={scenario === id}
              onClick={() => changeScenario(id)}>{label}{scenario === id && <Check aria-hidden="true" />}</Button>,
          )}</div>
        </section>
        <section className="invite-review-section">
          <h3>访问状态</h3>
          <Button variant="ghost" className="invite-reset" onClick={() => changeAccess('访问已到期，请重新输入邀请码。', 'normal')}>模拟 30 天后到期</Button>
          <Button variant="ghost" className="invite-reset" onClick={() => changeAccess('邀请已撤销，请联系邀请你的朋友。', 'revoked')}>模拟撤销访问</Button>
          {pendingAccessNotice && <p role="status">后续访问已失效，当前通话继续；挂断后需要重新验证。</p>}
          <Button variant="outline" className="invite-reset" onClick={() => { clearSession(); setScenario('normal'); }}><RotateCcw aria-hidden="true" />清除体验，重新开始</Button>
        </section>
      </aside>
    </div>
  </TooltipProvider>;
}
