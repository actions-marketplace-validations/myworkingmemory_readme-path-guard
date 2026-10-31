import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as delivery from '../src/github.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40), blob = 'c'.repeat(40);
const root = '/repos/owner/repo';
const botLogin = 'guard[bot]';
const README_TEXT = '[Guide](guide.md)';
const README_BYTES = Buffer.byteLength(README_TEXT, 'utf8');

function repository({ comments = [], malformedBlob = false, beforeWrite } = {}) {
  const writes = [];
  let nextId = 100;
  const stored = structuredClone(comments);
  const request = async (path, options = {}) => {
    if (options.method === 'POST') {
      const comment = { id: nextId++, user: { login: botLogin }, body: options.body.body };
      stored.push(comment); writes.push({ path, ...options }); return structuredClone(comment);
    }
    if (options.method === 'PATCH') {
      const id = Number(path.split('/').at(-1));
      const comment = stored.find(item => item.id === id);
      if (comment) comment.body = options.body.body;
      writes.push({ path, ...options }); return structuredClone(comment || { id });
    }
    if (options.method === 'DELETE') {
      const id = Number(path.split('/').at(-1));
      const index = stored.findIndex(item => item.id === id);
      if (index >= 0) stored.splice(index, 1);
      writes.push({ path, ...options }); return null;
    }
    if (path === `${root}/pulls/1`) return { state: 'open', base: { sha: base }, head: { sha: head } };
    if (path.startsWith(`${root}/issues/1/comments?`)) return structuredClone(stored);
    if (path.includes('/git/trees/')) return { truncated: false, tree: [
      { path: 'README.md', type: 'blob', mode: '100644', size: README_BYTES, sha: blob },
      ...(path.includes(base) ? [{ path: 'guide.md', type: 'blob', mode: '100644', sha: 'd'.repeat(40) }] : []),
    ] };
    if (path.includes('/git/blobs/')) return malformedBlob
      ? { encoding: 'base64', size: 0, content: '!!!!' }
      : { encoding: 'base64', size: README_BYTES, content: Buffer.from(README_TEXT).toString('base64') };
    throw new Error('Unexpected synthetic request.');
  };
  return { stored, writes, request, repo: 'owner/repo', number: 1, botLogin, beforeWrite };
}

test('old unversioned clean snapshots are rescanned after a checker release', async () => {
  const f = repository({ comments: [{ id: 7, user: { login: botLogin }, body: `${delivery.MARKER}\n<!-- snapshot:${base}:${head} -->` }] });
  const result = await delivery.runPullRequest({ ...f, skipUnchanged: true });
  assert.equal(result.findings?.length, 1);
  assert.equal(f.writes[0].method, 'PATCH');
});

test('concurrent first checks converge on one owned comment and preserve human comments', async () => {
  const f = repository({ comments: [{ id: 3, user: { login: 'human' }, body: `Human note ${delivery.MARKER}` }] });
  await Promise.all([delivery.runPullRequest(f), delivery.runPullRequest(f)]);
  assert.equal(f.stored.filter(comment => comment.user.login === botLogin).length, 1);
  assert.equal(f.stored.find(comment => comment.id === 3).body, `Human note ${delivery.MARKER}`);
});

test('malformed base64 cannot silently become an empty README and a clean result', async () => {
  const f = repository({ malformedBlob: true });
  await assert.rejects(delivery.runPullRequest(f), /README|base64|complete/);
  assert.equal(f.writes.length, 0);
});

test('declared README bytes cannot disagree with decoded bytes or immutable tree size', async () => {
  const f = repository();
  const request = async (path, options) => path.includes('/git/blobs/')
    ? { encoding: 'base64', size: README_BYTES, content: '' } : f.request(path, options);
  await assert.rejects(delivery.runPullRequest({ ...f, request }), /README|byte|size|complete/);
  assert.equal(f.writes.length, 0);
});

test('README sizes must be finite safe nonnegative integers and agree in both API responses', async () => {
  for (const bad of [undefined, null, NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, README_BYTES + 1]) {
    for (const at of ['tree', 'blob']) {
      const f = repository();
      const request = async (path, options) => {
        const value = await f.request(path, options);
        if (at === 'tree' && path.includes('/git/trees/')) value.tree[0].size = bad;
        if (at === 'blob' && path.includes('/git/blobs/')) value.size = bad;
        return value;
      };
      await assert.rejects(delivery.runPullRequest({ ...f, request }), /README|size|complete/);
      assert.equal(f.writes.length, 0);
    }
  }
});

test('a genuinely empty README remains valid when all immutable byte counts are zero', async () => {
  const f = repository();
  const request = async (path, options) => {
    const value = await f.request(path, options);
    if (path.includes('/git/trees/')) value.tree[0].size = 0;
    if (path.includes('/git/blobs/')) { value.size = 0; value.content = ''; }
    return value;
  };
  const result = await delivery.runPullRequest({ ...f, request });
  assert.equal(result.checkedReadmes, 1);
  assert.equal(result.checkedLinks, 0);
  assert.deepEqual(result.findings, []);
});

test('revoked or unavailable entitlement immediately before a write prevents the mutation', async () => {
  let checks = 0;
  const f = repository({ beforeWrite: async () => { checks++; throw new Error('Synthetic entitlement unavailable.'); } });
  await assert.rejects(delivery.runPullRequest(f), /entitlement unavailable/);
  assert.equal(checks, 1);
  assert.equal(f.writes.length, 0);
});

test('only current checker-version snapshots can skip the already checked commit', async () => {
  const f = repository({ comments: [{ id: 7, user: { login: botLogin }, body: `${delivery.MARKER}\n${delivery.snapshotMarker(base, head)}` }] });
  assert.equal((await delivery.runPullRequest({ ...f, skipUnchanged: true })).skipped, 'unchanged');
  assert.equal(f.writes.length, 0);
});

test('foreign markers and invalid owned comment IDs cannot redirect a comment update', async () => {
  const f = repository({ comments: [{ id: '7/../../pulls/1', user: { login: botLogin }, body: delivery.MARKER }] });
  await assert.rejects(delivery.runPullRequest(f), /comment identity/);
  assert.equal(f.writes.length, 0);
});

test('a tree without an explicit complete marker cannot produce a clean result', async () => {
  const f = repository();
  const request = async (path, options) => {
    const value = await f.request(path, options);
    if (path.includes('/git/trees/')) delete value.truncated;
    return value;
  };
  await assert.rejects(delivery.runPullRequest({ ...f, request }), /incomplete/);
  assert.equal(f.writes.length, 0);
});

test('GitHub PR-file pagination limit cannot silently omit a README rename', async () => {
  const f = repository();
  const request = async (path, options) => {
    if (path.includes('/pulls/1/files?')) return Array(100).fill({ status: 'modified', filename: 'file.txt' });
    const value = await f.request(path, options);
    if (path.includes(`/git/trees/${head}`)) value.tree[0].path = 'README.markdown';
    return value;
  };
  await assert.rejects(delivery.runPullRequest({ ...f, request }), /Pagination limit/);
  assert.equal(f.writes.length, 0);
});

test('personal token author is identified instead of repeatedly posting as the wrong bot', async () => {
  const f = repository({ comments: [{ id: 7, user: { login: 'personal-owner' }, body: delivery.MARKER }] });
  const owner = await delivery.commentAuthor(async path => {
    assert.equal(path, '/user'); return { login: 'personal-owner' };
  });
  await delivery.runPullRequest({ ...f, botLogin: owner });
  assert.equal(f.writes[0].method, 'PATCH');
  assert.equal(f.writes[0].path, `${root}/issues/comments/7`);
});

test('default GitHub token and named custom App tokens preserve explicit bot identities', async () => {
  const forbidden = Object.assign(new delivery.GuardError('Forbidden'), { status: 403 });
  assert.equal(await delivery.commentAuthor(async () => { throw forbidden; }), 'github-actions[bot]');
  assert.equal(await delivery.commentAuthor(async () => { throw Error('Must not probe'); }, 'custom-app[bot]'), 'custom-app[bot]');
  await assert.rejects(delivery.commentAuthor(async () => { throw Object.assign(new Error('bad credentials'), { status: 401 }); }), /bad credentials/);
  await assert.rejects(delivery.commentAuthor(async () => ({}), '../unsafe'), /author/);
});

const plan = { id: 99, price_model: 'FREE', monthly_price_in_cents: 0, yearly_price_in_cents: 0 };
const entitlement = { id: 10, marketplace_purchase: { plan } };

function worker({ subscriptions = [entitlement], badRepo = false, oldCache = false, installationCount = 1,
  exhaustFirst = false } = {}) {
  const f = repository({ comments: oldCache ? [{ id: 8, user: { login: botLogin }, body: `${delivery.MARKER}\n${delivery.snapshotMarker(base, head)}` }] : [] });
  const calls = [], revoked = [];
  let subscriptionCalls = 0, minted = 0;
  const app = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/app') return { id: 123, slug: 'guard' };
    if (path.startsWith('/app/installations?')) return Array.from({ length: installationCount }, (_, i) => ({ id: i + 1, account: { id: 10 } }));
    if (path === '/marketplace_listing/accounts/10') {
      const value = subscriptions[Math.min(subscriptionCalls++, subscriptions.length - 1)];
      if (value instanceof Error) throw value;
      return structuredClone(value);
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(options.body.permissions, { contents: 'read', pull_requests: 'write' });
      minted++;
      return { token: `synthetic-installation-${path.split('/')[3]}` };
    }
    throw new Error('Unexpected synthetic App endpoint.');
  };
  const installationClient = (token, options) => async (path, settings = {}) => {
    if (path === '/installation/token' && settings.method === 'DELETE') {
      assert.equal(options.budget, 1); revoked.push(token); return null;
    }
    if (path.startsWith('/installation/repositories?')) return { repositories: [
      ...(badRepo ? [{ id: 1, full_name: 'owner/inaccessible' }] : []), { id: 2, full_name: 'owner/repo' },
    ] };
    if (path.startsWith('/repos/owner/inaccessible/pulls?')) throw new delivery.GuardError('Synthetic private repository unavailable.');
    if (path.startsWith(`${root}/pulls?`)) return [{ number: 1 }];
    if (exhaustFirst && token.endsWith('-1')) throw new delivery.CapacityError('Synthetic exhausted scan budget.');
    return f.request(path, settings);
  };
  return { ...f, app, installationClient, calls, revoked, minted: () => minted,
    subscriptionCalls: () => subscriptionCalls, run: freePlanId => delivery.runAppChecks({ app, appId: '123', freePlanId,
      installationClient, deadline: Date.now() + 10000, epoch: 0 }) };
}

test('App verifies current approved free entitlement before token minting and again before a comment', async () => {
  const f = worker();
  assert.deepEqual(await f.run('99'), { checked: 1, skipped: 0, failures: 0, marketplaceRequired: true });
  assert.equal(f.subscriptionCalls(), 2);
  assert.equal(f.minted(), 1);
  assert.equal(f.revoked.length, 1);
  const checkIndex = f.calls.findIndex(call => call.path === '/marketplace_listing/accounts/10');
  const mintIndex = f.calls.findIndex(call => call.options.method === 'POST');
  assert.ok(checkIndex < mintIndex);
  assert.equal(f.calls.some(call => call.path.includes('stubbed')), false);
});

test('cancelled, paid, foreign-account, missing and pending-only plans fail before any scan token', async () => {
  const unavailable = Object.assign(new delivery.GuardError('Synthetic cancelled account.'), { status: 404 });
  for (const subscription of [unavailable, {}, { ...entitlement, id: 11 },
    { id: 10, marketplace_pending_change: { plan } },
    { id: 10, marketplace_purchase: { plan: { ...plan, id: 100 } } },
    { id: 10, marketplace_purchase: { plan: { ...plan, price_model: 'FLAT_RATE' } } },
    { id: 10, marketplace_purchase: { plan: { ...plan, yearly_price_in_cents: 1 } } }]) {
    const f = worker({ subscriptions: [subscription] });
    assert.deepEqual(await f.run('99'), { checked: 0, skipped: 0, failures: 1, marketplaceRequired: true });
    assert.equal(f.minted(), 0);
    assert.equal(f.writes.length, 0);
  }
});

test('cancellation between scan and comment blocks the mutation and still revokes its token', async () => {
  const f = worker({ subscriptions: [entitlement, Object.assign(new delivery.GuardError('Synthetic cancelled account.'), { status: 404 })] });
  assert.deepEqual(await f.run('99'), { checked: 0, skipped: 0, failures: 1, marketplaceRequired: true });
  assert.equal(f.subscriptionCalls(), 2);
  assert.equal(f.writes.length, 0);
  assert.equal(f.revoked.length, 1);
});

test('a future free plan cannot override a currently paid plan, while current free access remains valid', async () => {
  const denied = worker({ subscriptions: [{ ...entitlement,
    marketplace_purchase: { plan: { ...plan, price_model: 'FLAT_RATE', monthly_price_in_cents: 100 } },
    marketplace_pending_change: { plan } }] });
  assert.equal((await denied.run('99')).failures, 1);
  assert.equal(denied.minted(), 0);
  const valid = worker({ subscriptions: [{ ...entitlement,
    marketplace_pending_change: { plan: { ...plan, price_model: 'FLAT_RATE', monthly_price_in_cents: 100 } } }] });
  assert.equal((await valid.run('99')).checked, 1);
});

test('missing approved plan configuration fails before any App request, token, or comment', async () => {
  for (const freePlanId of [undefined, '', '0', '-1', 'not-a-plan']) {
    const f = worker();
    await assert.rejects(f.run(freePlanId), /configuration|plan/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.minted(), 0);
    assert.equal(f.writes.length, 0);
  }
});

test('bad repositories do not mask healthy repositories with approved current entitlement', async () => {
  const f = worker({ badRepo: true });
  const result = await f.run('99');
  assert.deepEqual(result, { checked: 1, skipped: 0, failures: 1, marketplaceRequired: true });
  assert.equal(f.subscriptionCalls(), 2);
  assert.equal(f.writes.length, 1);
  assert.equal(JSON.stringify(result).includes('owner'), false);
});

test('an exhausted installation does not prevent a later installation or token cleanup', async () => {
  const f = worker({ installationCount: 2, exhaustFirst: true });
  const result = await f.run('99');
  assert.equal(result.checked, 1);
  assert.equal(result.failures, 1);
  assert.equal(f.minted(), 2);
  assert.equal(f.revoked.length, 2);
});

test('current cached snapshots still verify entitlement before they skip', async () => {
  const f = worker({ oldCache: true });
  assert.deepEqual(await f.run('99'), { checked: 0, skipped: 1, failures: 0, marketplaceRequired: true });
  assert.equal(f.subscriptionCalls(), 1);
  assert.equal(f.writes.length, 0);
});

test('a canonical Git LFS pointer is incomplete content, never an empty clean README', async () => {
  const f = repository();
  const text = 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'f'.repeat(64) + '\nsize 300000\n';
  const request = async (path, options) => {
    if (path.includes('/git/blobs/')) return { encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') };
    const value = await f.request(path, options);
    if (path.includes('/git/trees/')) value.tree[0].size = Buffer.byteLength(text);
    return value;
  };
  await assert.rejects(delivery.runPullRequest({ ...f, request }), /Git LFS pointer/);
  assert.equal(f.writes.length, 0);
});

test('actual Action entry updates a personal-token comment and logs only aggregate counts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'readme-guard-delivery-'));
  const eventPath = join(directory, 'event.json'), tracePath = join(directory, 'trace.json');
  try {
    await writeFile(eventPath, JSON.stringify({ number: 1, pull_request: { number: 1 } }));
    const preload = `
      import { writeFileSync } from 'node:fs';
      const calls = [];
      globalThis.fetch = async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (options.redirect !== 'error') throw Error('Unsafe redirect policy');
        if (options.method === 'PATCH') {
          calls.push({ path, method: options.method });
          writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(calls));
          return Response.json({ id: 7 });
        }
        if (options.method && options.method !== 'GET') throw Error('Unexpected mutation');
        if (path === '/user') return Response.json({ login: 'personal-owner' });
        if (path.endsWith('/pulls/1')) return Response.json({ state: 'open', base: { sha: '${base}' }, head: { sha: '${head}' } });
        if (path.endsWith('/issues/1/comments')) return Response.json([{ id: 7, user: { login: 'personal-owner' }, body: ${JSON.stringify(delivery.MARKER)} }]);
        if (path.includes('/git/trees/')) return Response.json({ truncated: false, tree: [
          { path: 'README.md', type: 'blob', mode: '100644', size: ${README_BYTES}, sha: '${blob}' },
          ...(path.includes('${base}') ? [{ path: 'guide.md', type: 'blob', mode: '100644', sha: '${'d'.repeat(40)}' }] : [])
        ] });
        if (path.includes('/git/blobs/')) return Response.json({ encoding: 'base64', size: ${README_BYTES}, content: '${Buffer.from(README_TEXT).toString('base64')}' });
        throw Error('Unexpected API endpoint');
      };
    `;
    const loader = 'data:text/javascript;base64,' + Buffer.from(preload).toString('base64');
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--import', loader, fileURLToPath(new URL('../src/action.mjs', import.meta.url))], {
        env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: 'owner/repo', 'INPUT_GITHUB-TOKEN': 'synthetic-personal-token', 'INPUT_FAIL-ON-BROKEN': 'false' },
        timeout: 10000,
      });
    assert.deepEqual(JSON.parse(await readFile(tracePath, 'utf8')), [{ path: `${root}/issues/comments/7`, method: 'PATCH' }]);
    assert.match(stdout, /1 READMEs checked; 1 newly broken links/);
    assert.equal(stdout.includes('personal-owner'), false);
    assert.equal(stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
