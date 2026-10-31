import { build } from 'esbuild';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { CHECK_VERSION } from '../src/github.mjs';

const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
if (packageInfo.version !== CHECK_VERSION) {
  throw new Error('Release version and cached-check version must match.');
}

await mkdir('dist', { recursive: true });
for (const obsolete of ['dist/action.cjs', 'dist/app-worker.cjs']) {
  await rm(obsolete, { force: true });
}
await Promise.all(['action', 'app-worker', 'parser-worker'].map(entry => build({
  entryPoints: [`src/${entry}.mjs`],
  tsconfig: 'tsconfig.json',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: `dist/${entry}.mjs`,
  logLevel: 'info',
})));
