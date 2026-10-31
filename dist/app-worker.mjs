// src/app-worker.mjs
import { createSign } from "node:crypto";

// src/check-in-worker.mjs
import { Worker } from "node:worker_threads";
var ParserCapacityError = class extends Error {
  constructor() {
    super("README parsing exceeded the safe time or memory limit; coverage is incomplete.");
    this.code = "PARSER_LIMIT";
  }
};
var ParserRunError = class extends Error {
  constructor() {
    super("The isolated README parser could not complete; coverage is incomplete.");
    this.code = "PARSER_FAILURE";
  }
};
function checkRepositoryBounded(input, { timeoutMs = 5e3 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1e4) {
    throw new TypeError("Invalid parser deadline.");
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parser-worker.mjs", import.meta.url), {
      workerData: input,
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const timer = setTimeout(() => {
      void finish(new ParserCapacityError());
    }, timeoutMs);
    async function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => {
      });
      if (error) reject(error);
      else resolve(result);
    }
    worker.once("message", (message) => {
      if (message?.ok !== true || !Array.isArray(message.result?.findings) || !Number.isSafeInteger(message.result?.checkedReadmes) || !Number.isSafeInteger(message.result?.checkedLinks)) {
        void finish(new ParserRunError());
      } else {
        void finish(null, message.result);
      }
    });
    worker.once("error", (error) => {
      void finish(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new ParserCapacityError() : new ParserRunError());
    });
    worker.once("exit", () => {
      if (!settled) void finish(new ParserRunError());
    });
  });
}

// src/rotation.mjs
function rotate(items, step) {
  if (!items.length) return [];
  const offset = (step % items.length + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}
function rotationSteps(epoch, installationCount, repoCount = 1) {
  const installations = Math.max(1, installationCount);
  return {
    installation: epoch,
    repository: Math.floor(epoch / installations),
    pull: Math.floor(epoch / (installations * Math.max(1, repoCount)))
  };
}

// src/github.mjs
var MARKER = "<!-- mywkm-readme-path-guard:v1 -->";
var CHECK_VERSION = "1.0.1";
var SHA = /^[a-f0-9]{40,64}$/i;
var REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var README = /(^|\/)readme\.(md|markdown)$/i;
var MAX_READMES = 50;
var MAX_BYTES = 262144;
var GuardError = class extends Error {
};
var CapacityError = class extends GuardError {
};
function createClient(token, { fetcher = fetch, budget = 450, deadline = Infinity } = {}) {
  if (typeof token !== "string" || !token) throw new GuardError("A GitHub token is required.");
  let remaining = budget;
  return async function request(path, { method = "GET", body } = {}) {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
      throw new GuardError("Invalid API path.");
    }
    if (--remaining < 0 || Date.now() >= deadline) throw new CapacityError("Request/time budget reached; coverage is incomplete.");
    const response = await fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(2e4, deadline - Date.now()))),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "MyWKM-README-Path-Guard",
        ...body === void 0 ? {} : { "content-type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
    if (!response.ok) {
      const error = new GuardError(`GitHub API returned ${response.status}; no clean result was recorded.`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    return response.json();
  };
}
async function pages(request, path, key = null, maxPages = 10) {
  const result = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await request(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = key ? data[key] : data;
    if (!Array.isArray(rows)) throw new GuardError("Unexpected GitHub list response.");
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new GuardError("Pagination limit reached; coverage is incomplete.");
}
function repoPath(repo) {
  if (!REPO.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) throw new GuardError("Invalid repository.");
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}
async function treeAt(request, root, sha) {
  if (!SHA.test(sha)) throw new GuardError("Invalid commit identity.");
  const data = await request(`${root}/git/trees/${sha}?recursive=1`);
  if (data.truncated !== false || !Array.isArray(data.tree)) throw new GuardError("Repository tree is incomplete; check cannot pass.");
  return data.tree;
}
async function readmesAt(request, root, tree) {
  const readmes = tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000" && README.test(entry.path));
  if (readmes.length > MAX_READMES) throw new GuardError("Repository exceeds the 50-README limit; check cannot pass.");
  const result = /* @__PURE__ */ Object.create(null);
  for (const entry of readmes) {
    if (!SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BYTES) {
      throw new GuardError("README metadata is invalid or exceeds the safe input limit; check cannot pass.");
    }
    const blob = await request(`${root}/git/blobs/${entry.sha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_BYTES || blob.size !== entry.size || blob.content.length > MAX_BYTES * 1.5) {
      throw new GuardError("README could not be read completely; check cannot pass.");
    }
    const encoded = blob.content.replace(/[\r\n]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new GuardError("README base64 is invalid; check cannot pass.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length !== blob.size) throw new GuardError("README byte count does not match its metadata; check cannot pass.");
    if (bytes.length > MAX_BYTES) throw new GuardError("README exceeds the safe input limit; check cannot pass.");
    try {
      result[entry.path] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GuardError("README is not valid UTF-8; check cannot pass.");
    }
    if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:[a-f0-9]{64}\r?\nsize \d+\r?\n?$/.test(result[entry.path])) {
      throw new GuardError("README is a Git LFS pointer; its content was not checked.");
    }
  }
  return result;
}
function code(value) {
  return `<code>${String(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "&#64;").slice(0, 300)}</code>`;
}
function snapshotMarker(base, head) {
  return `<!-- snapshot:${CHECK_VERSION}:${base}:${head} -->`;
}
function commentBody(result, base, head) {
  const count = result.findings.length;
  const details = result.findings.slice(0, 3).map((f) => `${code(f.file)}:${f.line} \u2192 ${code(f.target)}`).join("; ");
  const line = count ? `README Path Guard @ ${head.slice(0, 7)}: ${count} newly broken repository link${count === 1 ? "" : "s"} \u2014 ${details}${count > 3 ? `; +${count - 3} more` : ""}.` : `README Path Guard @ ${head.slice(0, 7)}: no newly broken repository links (${result.checkedReadmes} README${result.checkedReadmes === 1 ? "" : "s"} checked).`;
  return `${line}
${MARKER}
${snapshotMarker(base, head)}`;
}
function isOwnedComment(comment, botLogin) {
  return comment.user?.login === botLogin && typeof comment.body === "string" && comment.body.includes(MARKER);
}
function ownedComments(comments, botLogin) {
  const owned = comments.filter((comment) => isOwnedComment(comment, botLogin));
  if (owned.some((comment) => !Number.isSafeInteger(comment.id) || comment.id < 1)) {
    throw new GuardError("GitHub comment identity is invalid; no comment was changed.");
  }
  return owned.sort((a, b) => a.id - b.id);
}
async function runPullRequest({ request, repo, number, botLogin, skipUnchanged = false, beforeWrite }) {
  if (!Number.isSafeInteger(number) || number < 1 || !botLogin) throw new GuardError("Valid pull request and bot identity required.");
  const root = repoPath(repo);
  const pr = await request(`${root}/pulls/${number}`);
  if (pr.state !== "open") return { skipped: "closed" };
  const base = pr.base?.sha, head = pr.head?.sha;
  if (!SHA.test(base || "") || !SHA.test(head || "")) throw new GuardError("Pull request snapshot is unavailable.");
  const comments = await pages(request, `${root}/issues/${number}/comments`);
  const existing = ownedComments(comments, botLogin)[0];
  if (skipUnchanged && existing?.body.includes(snapshotMarker(base, head))) return { skipped: "unchanged" };
  const baseTree = await treeAt(request, root, base);
  const headTree = await treeAt(request, root, head);
  const baseFiles = await readmesAt(request, root, baseTree);
  const headFiles = await readmesAt(request, root, headTree);
  const baseAliases = /* @__PURE__ */ Object.create(null);
  if (Object.keys(headFiles).some((path) => !Object.hasOwn(baseFiles, path))) {
    const changed = await pages(request, `${root}/pulls/${number}/files`, null, 30);
    for (const file of changed) {
      if (file.status === "renamed" && Object.hasOwn(headFiles, file.filename) && Object.hasOwn(baseFiles, file.previous_filename)) {
        baseAliases[file.filename] = file.previous_filename;
      }
    }
  }
  let result;
  let parserError;
  try {
    result = await checkRepositoryBounded({ baseFiles, headFiles, baseAliases, baseTree: baseTree.map((e) => e.path), headTree: headTree.map((e) => e.path) });
  } catch (error) {
    parserError = error;
  }
  const current = await request(`${root}/pulls/${number}`);
  if (current.state !== "open" || current.head?.sha !== head || current.base?.sha !== base) return { skipped: "changed" };
  const body = parserError ? `README Path Guard @ ${head.slice(0, 7)}: check incomplete \u2014 README parsing could not finish within safe resource limits.
${MARKER}
<!-- incomplete:${CHECK_VERSION}:${base}:${head} -->` : commentBody(result, base, head);
  async function mutate(path, options) {
    if (beforeWrite) await beforeWrite();
    return request(path, options);
  }
  if (existing) {
    if (existing.body !== body) await mutate(`${root}/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
  } else {
    const created = await mutate(`${root}/issues/${number}/comments`, { method: "POST", body: { body } });
    if (!Number.isSafeInteger(created?.id) || created.id < 1) throw new GuardError("Created comment identity is unavailable.");
    const after = ownedComments(await pages(request, `${root}/issues/${number}/comments`), botLogin);
    const canonical = after[0];
    if (canonical && canonical.id !== created.id) {
      const latest = await request(`${root}/pulls/${number}`);
      if (latest.state === "open" && latest.head?.sha === head && latest.base?.sha === base && canonical.body !== body) {
        await mutate(`${root}/issues/comments/${canonical.id}`, { method: "PATCH", body: { body } });
      }
      await mutate(`${root}/issues/comments/${created.id}`, { method: "DELETE" });
    }
  }
  if (parserError) throw parserError;
  return { ...result, base, head };
}
async function verifyMarketplaceEntitlement({ app, accountId, freePlanId }) {
  if (!/^[1-9]\d*$/.test(String(accountId || "")) || !/^[1-9]\d*$/.test(String(freePlanId || ""))) throw new GuardError("Marketplace account or free plan is not configured.");
  const account = await app(`/marketplace_listing/accounts/${accountId}`);
  const plan = account?.marketplace_purchase?.plan;
  if (String(account?.id) !== String(accountId) || String(plan?.id) !== String(freePlanId) || typeof plan?.price_model !== "string" || plan.price_model.toLowerCase() !== "free" || plan.monthly_price_in_cents !== 0 || plan.yearly_price_in_cents !== 0) throw new GuardError("The approved active free Marketplace plan could not be verified.");
}
async function runAppChecks({
  app,
  appId,
  freePlanId,
  installationClient = createClient,
  deadline = Date.now() + 6 * 60 * 1e3,
  epoch = Math.floor(Date.now() / 18e5)
}) {
  if (!/^[1-9]\d*$/.test(String(appId || "")) || !/^[1-9]\d*$/.test(String(freePlanId || ""))) {
    throw new GuardError("App configuration requires an approved free Marketplace plan.");
  }
  const info = await app("/app");
  if (String(info.id) !== String(appId) || !/^[A-Za-z0-9-]{1,100}$/.test(info.slug || "")) throw new GuardError("App identity could not be verified.");
  const botLogin = `${info.slug}[bot]`;
  const installations = await pages(app, "/app/installations");
  installations.sort((a, b) => a.id - b.id);
  const steps = rotationSteps(epoch, installations.length);
  let checked = 0, skipped = 0, failures = 0;
  for (const installation of rotate(installations, steps.installation)) {
    if (Date.now() >= deadline) {
      failures++;
      break;
    }
    if (installation.suspended_at) continue;
    try {
      if (!Number.isSafeInteger(installation.id) || installation.id < 1) throw new GuardError("Installation identity is invalid.");
      const beforeWrite = () => verifyMarketplaceEntitlement({ app, accountId: installation.account?.id, freePlanId });
      await beforeWrite();
      const access = await app(`/app/installations/${installation.id}/access_tokens`, { method: "POST", body: { permissions: { contents: "read", pull_requests: "write" } } });
      const request = installationClient(access.token, { budget: 350, deadline });
      try {
        const repos = await pages(request, "/installation/repositories", "repositories");
        repos.sort((a, b) => a.id - b.id);
        const repoSteps = rotationSteps(epoch, installations.length, repos.length);
        for (const repo of rotate(repos, repoSteps.repository)) {
          try {
            const root = repoPath(repo.full_name);
            const pulls = await pages(request, `${root}/pulls?state=open&sort=updated&direction=desc`);
            pulls.sort((a, b) => a.number - b.number);
            for (const pr of rotate(pulls, repoSteps.pull)) {
              if (pr.draft) continue;
              try {
                const result = await runPullRequest({ request, repo: repo.full_name, number: pr.number, botLogin, skipUnchanged: true, beforeWrite });
                result.skipped ? skipped++ : checked++;
              } catch (error) {
                if (error instanceof CapacityError) throw error;
                failures++;
              }
            }
          } catch (error) {
            if (error instanceof CapacityError) throw error;
            failures++;
          }
        }
      } finally {
        await installationClient(access.token, { budget: 1, deadline: Date.now() + 5e3 })("/installation/token", { method: "DELETE" }).catch(() => {
        });
      }
    } catch {
      failures++;
    }
  }
  return { checked, skipped, failures, marketplaceRequired: true };
}

// src/app-worker.mjs
function jwt(appId, key) {
  const now = Math.floor(Date.now() / 1e3);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
  return `${input}.${createSign("RSA-SHA256").update(input).end().sign(key, "base64url")}`;
}
async function main() {
  const appId = process.env.APP_ID;
  const key = process.env.APP_PRIVATE_KEY;
  if (!/^[1-9]\d*$/.test(appId || "") || !key) throw new Error("App credentials are not configured.");
  const deadline = Date.now() + 6 * 60 * 1e3;
  const app = (path, options) => createClient(jwt(appId, key), { deadline })(path, options);
  const { checked, skipped, failures } = await runAppChecks({
    app,
    appId,
    freePlanId: process.env.MARKETPLACE_FREE_PLAN_ID,
    deadline
  });
  console.log(`README Path Guard App: ${checked} checked; ${skipped} unchanged/closed; ${failures} incomplete.`);
  if (failures) process.exitCode = 1;
}
main().catch(() => {
  console.error("README Path Guard App could not complete; inspect configuration and access without exposing private repository data.");
  process.exitCode = 1;
});
