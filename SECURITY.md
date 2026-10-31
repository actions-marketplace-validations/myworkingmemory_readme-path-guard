# Security reporting

Email dean@myworkingmemory.ai with a concise reproduction. Do not post credentials, private repository contents or a working exploit against someone else's repository in a public issue.

The checker parses Markdown as data. It never runs contributor scripts or follows README links over the network. GitHub API requests use a fixed HTTPS origin and reject redirects. Tokens are never included in application logs.

The recommended `pull_request_target` workflow must keep trusted Action code separate from untrusted PR code. Do not check out or execute a contributor branch in that workflow. Prefer a pinned release commit. Enable only contents read and pull requests write.
