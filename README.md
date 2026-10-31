# README Path Guard

Catch the pull request that breaks your README's links to files in your repository.

Move a guide, delete an image, or mistype a filename: README Path Guard checks the proposed branch, compares it with the base, and updates one concise pull-request comment. Existing broken links stay out of the way.

**Free. No dashboard. No configuration file. No repository code execution.**

```text
README Path Guard @ abc1234: 1 newly broken repository link — README.md:8 → docs/setup.md.
```

## Add the Action

Create `.github/workflows/readme-path-guard.yml`:

```yaml
name: README paths
on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: readme-path-guard-${{ github.event.pull_request.number }}
  cancel-in-progress: false
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: myworkingmemory/readme-path-guard@v1
```

The one `uses:` line invokes the check. The surrounding workflow supplies the event and the permissions required to read files and write the comment. For reproducible dependency control, pin the full commit SHA from the release instead of the moving `v1` tag.

This workflow deliberately uses `pull_request_target` to comment on fork pull requests. **Do not add a checkout of the pull-request branch, run its scripts, or interpolate PR-controlled text into shell commands.** The Action reads GitHub API snapshots as data; it does not check out or execute the contributor's code. Use GitHub.com repositories; GitHub Enterprise Server is outside this release's scope.

Choose the Action **or** the managed App per repository; enabling both produces separate bot comments.

## What it checks

- Markdown links and images in `README.md` and `README.markdown`, including nested folders and case variants of the README name.
- Relative paths and repository-root paths, percent-encoded filenames, and case-sensitive Git paths.
- Targets lost through moves or deletions, even when the README itself is unchanged.
- A renamed README's old location when determining whether a problem already existed.

The tool checks **path existence**. It does not fetch external websites, validate heading anchors, inspect HTML `href`/`src`, follow symlinks/submodules, or scan arbitrary Markdown files. A reported line is the start of the containing Markdown block. It reports up to three examples in its one-line comment, with the total count when more exist. The full count is also an Action output. The checked head commit appears visibly so a historical comment cannot be mistaken for a newer scan.

The initial limits are 50 READMEs per snapshot, 256 KiB per README, complete Git trees, and bounded API pagination/requests. An incomplete or inaccessible scan fails rather than reporting clean. Organizations that restrict write tokens must allow the two documented permissions.

## Inputs and outputs

| Input | Default | Purpose |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Read repository contents and write the PR comment. |
| `fail-on-broken` | `true` | Set to `false` for a comment without failing the job. |

| Output | Meaning |
| --- | --- |
| `broken-links` | Newly broken local README link targets, deduplicated per README. |
| `checked-readmes` | Number of README files in the proposed branch checked. |

## Managed GitHub App

The same checker also has a scheduled App worker. App activation and its free Marketplace listing are being prepared; use the Action above now.

The App requests only repository contents read, pull requests write, and GitHub's required metadata read. An account owner chooses which repositories to enable. Its scan is scheduled twice an hour, best-effort; GitHub can delay scheduled runs. The worker rotates work to prevent a large early installation from owning every batch, refreshes authentication, revokes temporary installation tokens, and prints aggregate counts rather than private repository details. It skips unchanged snapshots and draft PRs. A disabled or failed schedule does not constitute a new passing check.

App installations, repositories selected, Action usage and paid customers are different measurements. Using this Action does not install the App or contribute to the App's installation count.

## Development

Node.js 22+ is required locally. The published Action runs on GitHub's Node.js 24 runtime.

```sh
npm ci --ignore-scripts
npm test
npm run build
```

The checked-in bundles allow users to run the Action without installing packages in their repository. The parser and bundle dependencies are pinned in `package-lock.json`; notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Support and data

Open an [issue](https://github.com/myworkingmemory/readme-path-guard/issues) for a reproducible problem, or email dean@myworkingmemory.ai. Keep private repository content and credentials out of public issues. See [data handling](PRIVACY.md) and [security reporting](SECURITY.md).

Copyright 2026 Myworkingmemory. Licensed under [Apache-2.0](LICENSE).
