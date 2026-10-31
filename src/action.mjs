import { readFileSync, appendFileSync } from 'node:fs';
import { createClient, runPullRequest } from './github.mjs';

async function main() {
  const allowed = new Set(['pull_request', 'pull_request_target']);
  if (!allowed.has(process.env.GITHUB_EVENT_NAME)) throw new Error('Run this Action on pull_request or pull_request_target.');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await runPullRequest({
    request: createClient(process.env['INPUT_GITHUB-TOKEN'] || process.env.GITHUB_TOKEN),
    repo: process.env.GITHUB_REPOSITORY,
    number: event.pull_request?.number ?? event.number,
    botLogin: 'github-actions[bot]'
  });
  if (result.skipped) {
    console.log('README Path Guard: pull request closed or changed; no stale result posted.');
    return;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `broken-links=${result.findings.length}\nchecked-readmes=${result.checkedReadmes}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `README Path Guard checked ${result.checkedReadmes} READMEs and found ${result.findings.length} newly broken repository links.\n`);
  console.log(`README Path Guard: ${result.checkedReadmes} READMEs checked; ${result.findings.length} newly broken links.`);
  if (result.findings.length && process.env['INPUT_FAIL-ON-BROKEN'] !== 'false') process.exitCode = 1;
}

main().catch(() => {
  // Avoid printing untrusted repository content, API responses, URLs or tokens.
  console.error('README Path Guard could not complete. Check token permissions and the documented input limits. No clean result was posted.');
  process.exitCode = 1;
});
