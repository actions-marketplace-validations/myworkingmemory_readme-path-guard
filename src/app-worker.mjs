import { createSign } from 'node:crypto';
import { CapacityError, createClient, pages, runPullRequest } from './github.mjs';
import { rotate, rotationSteps } from './rotation.mjs';

function jwt(appId, key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${input}.${createSign('RSA-SHA256').update(input).end().sign(key, 'base64url')}`;
}

async function main() {
  const appId = process.env.APP_ID;
  const key = process.env.APP_PRIVATE_KEY;
  if (!/^\d+$/.test(appId || '') || !key) throw new Error('App credentials are not configured.');
  const deadline = Date.now() + 6 * 60 * 1000;
  // Refresh for every App-level request; a queued/slow run never reuses an
  // expired JWT to mint an installation token.
  const app = (path, options) => createClient(jwt(appId, key), { deadline })(path, options);
  const info = await app('/app');
  const botLogin = `${info.slug}[bot]`;
  const installations = await pages(app, '/app/installations');
  installations.sort((a, b) => a.id - b.id);
  const epoch = Math.floor(Date.now() / 1800000);
  const steps = rotationSteps(epoch, installations.length);
  let checked = 0, skipped = 0, failures = 0;
  for (const installation of rotate(installations, steps.installation)) {
    if (Date.now() >= deadline) { failures++; break; }
    if (installation.suspended_at) continue;
    try {
      const access = await app(`/app/installations/${installation.id}/access_tokens`, { method: 'POST', body: { permissions: { contents: 'read', pull_requests: 'write' } } });
      const request = createClient(access.token, { budget: 350, deadline });
      try {
        const repos = await pages(request, '/installation/repositories', 'repositories');
        repos.sort((a, b) => a.id - b.id);
        const repoSteps = rotationSteps(epoch, installations.length, repos.length);
        for (const repo of rotate(repos, repoSteps.repository)) {
          const pulls = await pages(request, `/repos/${repo.full_name}/pulls?state=open&sort=updated&direction=desc`);
          pulls.sort((a, b) => a.number - b.number);
          for (const pr of rotate(pulls, repoSteps.pull)) {
            if (pr.draft) continue;
            try {
              const result = await runPullRequest({ request, repo: repo.full_name, number: pr.number, botLogin, skipUnchanged: true });
              result.skipped ? skipped++ : checked++;
            } catch (error) { if (error instanceof CapacityError) throw error; failures++; }
          }
        }
      } finally {
        // Use a separate one-request client so the cleanup works even when the
        // scanning budget is exhausted. GitHub tokens also expire automatically.
        await createClient(access.token, { budget: 1 })('/installation/token', { method: 'DELETE' }).catch(() => {});
      }
    } catch { failures++; }
  }
  // This workflow is public: never print installation names, repository identities,
  // README text, filenames, findings or API error bodies from private repositories.
  console.log(`README Path Guard App: ${checked} checked; ${skipped} unchanged/closed; ${failures} incomplete.`);
  if (failures) process.exitCode = 1;
}

main().catch(() => { console.error('README Path Guard App could not complete; inspect configuration and access without exposing private repository data.'); process.exitCode = 1; });
