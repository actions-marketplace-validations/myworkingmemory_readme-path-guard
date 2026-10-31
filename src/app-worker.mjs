import { createSign } from 'node:crypto';
import { createClient, runAppChecks } from './github.mjs';

function jwt(appId, key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).end().sign(key, 'base64url')}`;
}

async function main() {
  const appId = process.env.APP_ID;
  const key = process.env.APP_PRIVATE_KEY;
  if (!/^[1-9]\d*$/.test(appId || '') || !key) throw new Error('App credentials are not configured.');
  const deadline = Date.now() + 6 * 60 * 1000;
  // Refresh for every App-level request; a queued/slow run never reuses an
  // expired JWT to mint an installation token.
  const app = (path, options) => createClient(jwt(appId, key), { deadline })(path, options);
  const { checked, skipped, inactive, failures } = await runAppChecks({ app, appId,
    freePlanId: process.env.MARKETPLACE_FREE_PLAN_ID, deadline });
  // This workflow is public: never print installation names, repository identities,
  // README text, filenames, findings or API error bodies from private repositories.
  console.log(`README Path Guard App: ${checked} checked; ${skipped} unchanged/closed; ${inactive} inactive installations; ${failures} incomplete.`);
  if (failures) process.exitCode = 1;
}

main().catch(() => { console.error('README Path Guard App could not complete; inspect configuration and access without exposing private repository data.'); process.exitCode = 1; });
