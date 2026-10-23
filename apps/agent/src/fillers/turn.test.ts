import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FillerTurnGuard, type Speech } from './turn.js';

function speech(id: string) {
  const s = {
    id,
    finished: false,
    interrupted: false,
    done: () => s.finished || s.interrupted,
    interrupt: () => {
      s.interrupted = true;
    },
  };
  return s satisfies Speech;
}

function setup() {
  const fillerStarts: number[] = [];
  const dropped: string[] = [];
  const guard = new FillerTurnGuard({
    minSpeechMs: 500,
    onFillerStart: (at) => fillerStarts.push(at),
    onReplyDropped: (id) => dropped.push(id),
  });
  const reply = speech('reply');
  const filler = speech('filler');
  // Event order of a real turn: preemptive reply created, filler queued, turn committed.
  guard.replyCreated(reply);
  guard.fillerQueued(filler);
  guard.turnCommitted('reply');
  return { guard, reply, filler, fillerStarts, dropped };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('FillerTurnGuard', () => {
  it('reports the filler start, then lets the reply play', () => {
    const { guard, filler, reply, fillerStarts, dropped } = setup();
    expect(guard.agentState('speaking', 100)).toBe(true);
    filler.finished = true;
    guard.agentState('listening', 600);
    expect(guard.agentState('speaking', 620)).toBe(false);
    guard.userState('speaking');
    vi.advanceTimersByTime(1000);
    expect(fillerStarts).toEqual([100]);
    expect(reply.interrupted).toBe(false);
    expect(dropped).toEqual([]);
  });

  it('drops the queued reply once the caller has talked over the filler for minSpeechMs', () => {
    const { guard, reply, dropped } = setup();
    guard.agentState('speaking', 100);
    guard.userState('speaking');
    vi.advanceTimersByTime(499);
    expect(reply.interrupted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(reply.interrupted).toBe(true);
    expect(dropped).toEqual(['reply']);
  });

  it('keeps the reply when the caller only made a short sound', () => {
    const { guard, reply } = setup();
    guard.agentState('speaking', 100);
    guard.userState('speaking');
    vi.advanceTimersByTime(300);
    guard.userState('listening');
    vi.advanceTimersByTime(1000);
    expect(reply.interrupted).toBe(false);
  });

  it('leaves a reply that already started to the normal interruption handling', () => {
    const { guard, filler, reply } = setup();
    guard.agentState('speaking', 100);
    filler.finished = true;
    guard.agentState('speaking', 700);
    guard.userState('speaking');
    vi.advanceTimersByTime(1000);
    expect(reply.interrupted).toBe(false);
  });

  it('a new turn replaces the old one', () => {
    const { guard, reply } = setup();
    guard.agentState('speaking', 100);
    guard.userState('speaking');
    const next = speech('reply2');
    guard.replyCreated(next);
    guard.fillerQueued(speech('filler2'));
    guard.turnCommitted('reply2');
    vi.advanceTimersByTime(1000);
    expect(reply.interrupted).toBe(false);
    expect(next.interrupted).toBe(false);
  });
});
