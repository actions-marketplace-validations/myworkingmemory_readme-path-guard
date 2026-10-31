import { Worker } from 'node:worker_threads';

export class ParserCapacityError extends Error {
  constructor() {
    super('README parsing exceeded the safe time or memory limit; coverage is incomplete.');
    this.code = 'PARSER_LIMIT';
  }
}

export class ParserRunError extends Error {
  constructor() {
    super('The isolated README parser could not complete; coverage is incomplete.');
    this.code = 'PARSER_FAILURE';
  }
}

// The worker location is fixed trusted product code. Repository content is
// structured-cloned as data, never used as a module, filename, command or URL.
export function checkRepositoryBounded(input, { timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new TypeError('Invalid parser deadline.');
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parser-worker.mjs', import.meta.url), {
      workerData: input,
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    });
    // A worker cannot echo private repository data into a public App runner.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const timer = setTimeout(() => { void finish(new ParserCapacityError()); }, timeoutMs);
    async function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(result);
    }
    worker.once('message', message => {
      if (message?.ok !== true || !Array.isArray(message.result?.findings)
        || !Number.isSafeInteger(message.result?.checkedReadmes)
        || !Number.isSafeInteger(message.result?.checkedLinks)) {
        void finish(new ParserRunError());
      } else {
        void finish(null, message.result);
      }
    });
    worker.once('error', error => { void finish(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new ParserCapacityError() : new ParserRunError()); });
    worker.once('exit', () => { if (!settled) void finish(new ParserRunError()); });
  });
}
