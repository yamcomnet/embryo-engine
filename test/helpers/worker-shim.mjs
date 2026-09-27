// test/helpers/worker-shim.mjs — runs src/sim-worker.js (a browser module worker) in a node worker thread:
// `self`, onmessage and postMessage (with transfer lists) mapped onto worker_threads' parentPort.
import { parentPort } from 'node:worker_threads';

let handler = null;
globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
Object.defineProperty(globalThis, 'onmessage', { configurable: true, get: () => handler, set: (fn) => { handler = fn; } });
globalThis.addEventListener = () => {};          // 'unhandledrejection': node reports those itself
parentPort.on('message', (data) => { if (handler) handler({ data }); });
await import('../../src/sim-worker.js');
