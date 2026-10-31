import { parentPort, workerData } from 'node:worker_threads';
import { checkRepository } from './core.mjs';

try {
  parentPort.postMessage({ ok: true, result: checkRepository(workerData) });
} catch {
  // Error messages from parser internals may contain input. Send no excerpts,
  // stack traces or repository identities across the worker boundary.
  parentPort.postMessage({ ok: false });
}
