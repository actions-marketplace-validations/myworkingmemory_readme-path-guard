import test from 'node:test';
import assert from 'node:assert/strict';
import { runPullRequest, commentBody, createClient, pages, MARKER, snapshotMarker } from '../src/github.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), blob = 'c'.repeat(40);
const pr = { state: 'open', base: { sha: base }, head: { sha: head } };
const root = '/repos/owner/repo';
function fake({ comments = [], mutate = false, truncated = false } = {}) {
  const writes = []; let reads = 0;
  return { writes, request: async (path, options = {}) => {
    if (options.method) { writes.push({ path, ...options }); return { id: 42 }; }
    if (path === `${root}/pulls/1`) return mutate && ++reads > 1 ? { ...pr, head: { sha: 'd'.repeat(40) } } : pr;
    if (path.startsWith(`${root}/issues/1/comments?`)) return comments;
    if (path.includes('/git/trees/')) return { truncated, tree: [
      { path: 'README.md', type: 'blob', mode: '100644', size: 17, sha: blob },
      ...(path.includes(base) ? [{ path: 'guide.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40) }] : [])
    ] };
    if (path === `${root}/git/blobs/${blob}`) return { encoding: 'base64', size: 17, content: Buffer.from('[Guide](guide.md)').toString('base64') };
    throw new Error(`Unexpected test request: ${path}`);
  } };
}

test('posts one newly broken link from a deleted target', async () => {
  const f = fake();
  const result = await runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'github-actions[bot]' });
  assert.equal(result.findings.length, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].method, 'POST');
  assert.match(f.writes[0].body.body, /1 newly broken repository link/);
});
test('updates its own comment instead of posting another', async () => {
  const f = fake({ comments: [{ id: 7, user: { login: 'github-actions[bot]' }, body: MARKER }] });
  await runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'github-actions[bot]' });
  assert.equal(f.writes[0].method, 'PATCH');
  assert.equal(f.writes[0].path, `${root}/issues/comments/7`);
});
test('does not edit a human comment containing the marker', async () => {
  const f = fake({ comments: [{ id: 7, user: { login: 'attacker' }, body: MARKER }] });
  await runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'github-actions[bot]' });
  assert.equal(f.writes[0].method, 'POST');
});
test('does not post stale results after a push', async () => {
  const f = fake({ mutate: true });
  assert.equal((await runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'github-actions[bot]' })).skipped, 'changed');
  assert.equal(f.writes.length, 0);
});
test('a truncated tree cannot produce a passing comment', async () => {
  const f = fake({ truncated: true });
  await assert.rejects(runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'github-actions[bot]' }), /incomplete/);
  assert.equal(f.writes.length, 0);
});
test('App skips a previously completed exact snapshot', async () => {
  const f = fake({ comments: [{ id: 7, user: { login: 'guard[bot]' }, body: `${MARKER}\n${snapshotMarker(base, head)}` }] });
  const result = await runPullRequest({ ...f, repo: 'owner/repo', number: 1, botLogin: 'guard[bot]', skipUnchanged: true });
  assert.equal(result.skipped, 'unchanged');
  assert.equal(f.writes.length, 0);
});
test('comments neutralize HTML, mentions and newlines in repository data', () => {
  const body = commentBody({ checkedReadmes: 1, findings: [{ file: '<script>\n@everyone', target: '</code><img src=x>@team', line: 1 }] }, base, head);
  assert.ok(!body.includes('<script>'));
  assert.ok(!body.includes('<img'));
  assert.ok(!body.includes('@everyone'));
  assert.equal(body.split('\n').length, 3);
});
test('authenticated requests never follow redirects and stay on GitHub API', async () => {
  let captured;
  const request = createClient('synthetic-test-token', { fetcher: async (url, options) => {
    captured = { url, options }; return { ok: true, status: 200, json: async () => ({}) };
  } });
  await request('/app');
  assert.equal(captured.url, 'https://api.github.com/app');
  assert.equal(captured.options.redirect, 'error');
  await assert.rejects(request('//evil.example'), /Invalid API path/);
});
test('pagination and request limits fail visibly', async () => {
  await assert.rejects(pages(async () => Array(100).fill({}), '/rows', null, 2), /incomplete/);
  const request = createClient('synthetic', { budget: 0 });
  await assert.rejects(request('/app'), /budget/);
});
test('README over the content limit fails without posting', async () => {
  const f = fake(); const request = async (path, options) => path.includes('/git/blobs/')
    ? { encoding: 'base64', size: 9999999, content: '' } : f.request(path, options);
  await assert.rejects(runPullRequest({ request, repo: 'owner/repo', number: 1, botLogin: 'guard[bot]' }), /check cannot pass/);
  assert.equal(f.writes.length, 0);
});

test('a parser failure replaces a historical clean result with an explicit incomplete result', async () => {
  const f = fake({ comments: [{ id: 7, user: { login: 'guard[bot]' }, body: `${MARKER}\nHistorical clean result` }] });
  const request = async (path, options) => {
    const response = await f.request(path, options);
    if (path.includes('/git/trees/')) response.tree.push({ path: '/noncanonical-path', type: 'blob' });
    return response;
  };
  await assert.rejects(runPullRequest({ request, repo: 'owner/repo', number: 1, botLogin: 'guard[bot]' }), { code: 'PARSER_FAILURE' });
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].method, 'PATCH');
  assert.match(f.writes[0].body.body, /check incomplete/);
  assert.ok(!f.writes[0].body.body.includes(snapshotMarker(base, head)));
});
