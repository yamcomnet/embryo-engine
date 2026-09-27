// test/worker.test.mjs — the simulation worker's fast-forward contract (a share link's jump), run for real in a node
// worker thread with the v1 engine:
//  • viewing a snapshot (and going back to live) during a fast-forward does not cancel it: it reaches its target,
//    ends with PROGRESS { done } (not cancelled), and the run lands paused at the target;
//  • a viewed snapshot is published during the jump (once), live frames are not;
//  • a run control (PAUSE, Space's "Stop") cancels it explicitly: PROGRESS { done, cancelled, tick < target }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { MSG } from '../src/shared.js';

const SHIM = new URL('./helpers/worker-shim.mjs', import.meta.url);

function startWorker() {
  const w = new Worker(SHIM);
  const inbox = [];
  const waiters = [];
  let seq = 0;
  w.on('message', (m) => {
    if (m.type === MSG.FRAME) {
      // ack like main.js: the buffers go back, so the worker keeps its credits
      const buffers = { cell: m.cell, life: m.life, idx: m.idx, events: m.events, morph: m.morph || undefined };
      const list = [m.cell.buffer, m.life.buffer, m.idx.buffer, m.events.buffer];
      if (m.morph) list.push(m.morph.buffer);
      w.postMessage({ type: MSG.ACK, id: m.id, buffers }, list);
      m = { type: m.type, tick: m.tick, running: m.running, viewing: m.viewing, ctl: m.ctl };
    }
    inbox.push(m);
    for (const x of waiters.splice(0)) x();
  });
  const send = (msg) => { msg.seq = ++seq; w.postMessage(msg); return seq; };
  // resolves with the first message (from `from` on) that matches; rejects after `ms`
  const waitFor = (pred, ms = 60000, from = 0) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      const hit = inbox.slice(from).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('timed out'));
      waiters.push(check);
      setTimeout(check, 50);
    };
    check();
  });
  return { w, inbox, send, waitFor, stop: () => w.terminate() };
}

test('worker: viewing a snapshot during a fast-forward does not cancel it; back to live lands at the target', { timeout: 120000 }, async () => {
  const W = startWorker();
  try {
    W.send({ type: MSG.INIT, seed: 3, speedIndex: 3, running: false, engine: 'v1', snapshotCap: 16, fieldsHz: 15 });
    await W.waitFor((m) => m.type === MSG.READY);
    const TARGET = 3000;
    W.send({ type: MSG.FAST_FORWARD, tick: TARGET });
    const ms = await W.waitFor((m) => m.type === MSG.MILESTONE && m.key === 'firstFates');
    const mark = W.inbox.length;
    const viewSeq = W.send({ type: MSG.VIEW_SNAPSHOT, snapId: ms.snapId });
    const vf = await W.waitFor((m) => m.type === MSG.FRAME && m.ctl === viewSeq, 20000, mark);
    assert.equal(vf.viewing?.snapId, ms.snapId, 'the viewed snapshot is published during the jump');
    assert.equal(vf.tick, ms.tick);
    // still fast-forwarding: progress keeps coming, nothing cancelled
    const prog = await W.waitFor((m) => m.type === MSG.PROGRESS && !m.done, 20000, mark);
    assert.ok(prog.tick > ms.tick && prog.target === TARGET);
    const liveSeq = W.send({ type: MSG.LIVE });
    const done = await W.waitFor((m) => m.type === MSG.PROGRESS && m.done, 90000, mark);
    assert.equal(done.cancelled, undefined, 'not cancelled');
    assert.equal(done.tick, TARGET, 'the jump reaches the link target');
    const lf = await W.waitFor((m) => m.type === MSG.FRAME && m.ctl === liveSeq && m.tick === TARGET, 20000, mark);
    assert.equal(lf.viewing, null);
    assert.equal(lf.running, false, 'a share link lands paused');
    // no live frame was published between the view and the end of the jump
    const between = W.inbox.slice(mark, W.inbox.indexOf(done)).filter((m) => m.type === MSG.FRAME && !m.viewing);
    assert.equal(between.length, 0, 'no live frames during the jump');
  } finally { await W.stop(); }
});

test('worker: a run control stops a fast-forward explicitly (cancelled, short of the target)', { timeout: 60000 }, async () => {
  const W = startWorker();
  try {
    W.send({ type: MSG.INIT, seed: 2, speedIndex: 3, running: false, engine: 'v1' });
    await W.waitFor((m) => m.type === MSG.READY);
    W.send({ type: MSG.FAST_FORWARD, tick: 500000 });
    await W.waitFor((m) => m.type === MSG.PROGRESS && !m.done && m.tick > 200);
    const mark = W.inbox.length;
    const s = W.send({ type: MSG.PAUSE });
    const done = await W.waitFor((m) => m.type === MSG.PROGRESS && m.done, 10000, mark);
    assert.equal(done.cancelled, true);
    assert.ok(done.tick > 200 && done.tick < done.target, `stopped at ${done.tick} of ${done.target}`);
    const f = await W.waitFor((m) => m.type === MSG.FRAME && m.ctl === s, 10000, mark);
    assert.equal(f.running, false);
    assert.equal(f.tick, done.tick, 'the run stays where the jump stopped');
  } finally { await W.stop(); }
});
