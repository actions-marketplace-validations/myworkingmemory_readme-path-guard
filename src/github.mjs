import { checkRepository } from './core.mjs';

export const MARKER = '<!-- mywkm-readme-path-guard:v1 -->';
const SHA = /^[a-f0-9]{40,64}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const README = /(^|\/)readme\.(md|markdown)$/i;
const MAX_READMES = 50;
const MAX_BYTES = 262144;

export class GuardError extends Error {}
export class CapacityError extends GuardError {}

// All authenticated traffic is restricted to GitHub's API. PR data is never run.
export function createClient(token, { fetcher = fetch, budget = 450, deadline = Infinity } = {}) {
  if (!token) throw new GuardError('A GitHub token is required.');
  let remaining = budget;
  return async function request(path, { method = 'GET', body } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path)) {
      throw new GuardError('Invalid API path.');
    }
    if (--remaining < 0 || Date.now() >= deadline) throw new CapacityError('Request/time budget reached; coverage is incomplete.');
    const response = await fetcher(`https://api.github.com${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'MyWKM-README-Path-Guard',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new GuardError(`GitHub API returned ${response.status}; no clean result was recorded.`);
    if (response.status === 204) return null;
    return response.json();
  };
}

export async function pages(request, path, key = null, maxPages = 10) {
  const result = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? data[key] : data;
    if (!Array.isArray(rows)) throw new GuardError('Unexpected GitHub list response.');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new GuardError('Pagination limit reached; coverage is incomplete.');
}

function repoPath(repo) {
  if (!REPO.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) throw new GuardError('Invalid repository.');
  return `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

async function treeAt(request, root, sha) {
  if (!SHA.test(sha)) throw new GuardError('Invalid commit identity.');
  const data = await request(`${root}/git/trees/${sha}?recursive=1`);
  if (data.truncated || !Array.isArray(data.tree)) throw new GuardError('Repository tree is incomplete; check cannot pass.');
  return data.tree;
}

async function readmesAt(request, root, tree) {
  const readmes = tree.filter(entry => entry.type === 'blob' && entry.mode !== '120000' && README.test(entry.path));
  if (readmes.length > MAX_READMES) throw new GuardError('Repository exceeds the 50-README limit; check cannot pass.');
  const result = Object.create(null);
  for (const entry of readmes) {
    if (!SHA.test(entry.sha) || entry.size > MAX_BYTES) throw new GuardError('README exceeds the safe input limit; check cannot pass.');
    const blob = await request(`${root}/git/blobs/${entry.sha}`);
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.size > MAX_BYTES || blob.content.length > MAX_BYTES * 1.5) {
      throw new GuardError('README could not be read completely; check cannot pass.');
    }
    const bytes = Buffer.from(blob.content, 'base64');
    if (bytes.length > MAX_BYTES) throw new GuardError('README exceeds the safe input limit; check cannot pass.');
    try { result[entry.path] = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new GuardError('README is not valid UTF-8; check cannot pass.'); }
  }
  return result;
}

function code(value) {
  return `<code>${String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/@/g, '&#64;').slice(0, 300)}</code>`;
}

export function commentBody(result, base, head) {
  const count = result.findings.length;
  const details = result.findings.slice(0, 3).map(f => `${code(f.file)}:${f.line} → ${code(f.target)}`).join('; ');
  const line = count
    ? `README Path Guard @ ${head.slice(0, 7)}: ${count} newly broken repository link${count === 1 ? '' : 's'} — ${details}${count > 3 ? `; +${count - 3} more` : ''}.`
    : `README Path Guard @ ${head.slice(0, 7)}: no newly broken repository links (${result.checkedReadmes} README${result.checkedReadmes === 1 ? '' : 's'} checked).`;
  return `${line}\n${MARKER}\n<!-- snapshot:${base}:${head} -->`;
}

function isOwnedComment(comment, botLogin) {
  return comment.user?.login === botLogin && typeof comment.body === 'string' && comment.body.includes(MARKER);
}

export async function runPullRequest({ request, repo, number, botLogin, skipUnchanged = false }) {
  if (!Number.isSafeInteger(number) || number < 1 || !botLogin) throw new GuardError('Valid pull request and bot identity required.');
  const root = repoPath(repo);
  const pr = await request(`${root}/pulls/${number}`);
  if (pr.state !== 'open') return { skipped: 'closed' };
  const base = pr.base?.sha, head = pr.head?.sha;
  if (!SHA.test(base || '') || !SHA.test(head || '')) throw new GuardError('Pull request snapshot is unavailable.');
  const comments = await pages(request, `${root}/issues/${number}/comments`);
  const existing = comments.find(comment => isOwnedComment(comment, botLogin));
  if (skipUnchanged && existing?.body.includes(`<!-- snapshot:${base}:${head} -->`)) return { skipped: 'unchanged' };
  const baseTree = await treeAt(request, root, base);
  const headTree = await treeAt(request, root, head);
  const baseFiles = await readmesAt(request, root, baseTree);
  const headFiles = await readmesAt(request, root, headTree);
  const baseAliases = Object.create(null);
  if (Object.keys(headFiles).some(path => !Object.hasOwn(baseFiles, path))) {
    const changed = await pages(request, `${root}/pulls/${number}/files`, null, 30);
    for (const file of changed) {
      if (file.status === 'renamed' && Object.hasOwn(headFiles, file.filename) && Object.hasOwn(baseFiles, file.previous_filename)) {
        baseAliases[file.filename] = file.previous_filename;
      }
    }
  }
  const result = checkRepository({ baseFiles, headFiles, baseAliases, baseTree: baseTree.map(e => e.path), headTree: headTree.map(e => e.path) });
  // A pushed commit must not receive the previous snapshot's clean result.
  const current = await request(`${root}/pulls/${number}`);
  if (current.state !== 'open' || current.head?.sha !== head || current.base?.sha !== base) return { skipped: 'changed' };
  const body = commentBody(result, base, head);
  if (existing) {
    if (existing.body !== body) await request(`${root}/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  } else {
    await request(`${root}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }
  return { ...result, base, head };
}
