# README Path Guard — data handling

README Path Guard reads GitHub pull-request metadata, repository path trees, README contents, and its own PR comments to check links to repository files. It compares snapshots in memory and writes a result to that repository's pull-request thread. The Action also writes numerical outputs and a summary in its workflow run.

The Action runs inside the adopting repository's GitHub workflow. The managed App worker runs in the publisher's GitHub-hosted workflow and uses GitHub App installation tokens limited to the repositories and permissions approved by the account owner. Private repository names, README contents and findings are excluded from its public workflow logs; only aggregate counts are printed.

This release does not fetch linked websites, run repository code, operate a customer dashboard, add analytics, sell repository data, or persist repository snapshots in a separate application database. GitHub stores repositories, PR comments, workflow records and App installation information under its platform controls. An old comment remains part of the PR history until changed or removed.

The free Marketplace event receiver verifies signed event payloads and acknowledges free-plan events without storing a separate entitlement database. Paid plans are disabled in this release.

Managed App setup is hosted on Myworkingmemory's existing Vercel website. It uses a short-lived secure browser cookie, checks GitHub identity, the selected installation's permissions and its approved free Marketplace purchase, then revokes the transient user token. The App worker checks GitHub's current subscription record before work and comment changes. Repository contents are parsed in a separate worker thread that does not inherit runner credentials. These controls do not create a separate customer database or dashboard.

An account owner can remove repository access or uninstall the App in GitHub settings. A repository owner can remove the workflow to stop the Action. Questions or deletion requests concerning publisher-held information: dean@myworkingmemory.ai.
