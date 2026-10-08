# Signed agent commits (SSH commit signing)

Agent commits can be signed with an SSH key, so GitHub shows them as
**Verified** and accepts them on branches or instances that require signed
commits. **Accenture GitHub Enterprise enforces verified commits from
2026-10-23**: a push that contains an unsigned commit is rejected there.

Signing is optional. Without a signing key nothing changes: commits stay
unsigned, exactly as before.

## How it works

- A stored **SSH key** (SSH Keys page) becomes a **signing key** when it is
  given a commit identity: a name and an email. The same key can also be used
  for git access, or only for signing.
- For every run the platform picks one signing key, in this order:
  **personal → team → global**. The personal tier is the acting person (chat)
  or the team's Team Admin (automatic runs) — the same rule as for personal
  GitHub tokens (`docs/credentials.md`).
- Inside the agent container git is set up with `gpg.format=ssh` and
  `commit.gpgsign=true`. The signing program (`aee-ssh-sign`) sends the commit
  to the orchestrator, which signs it with `ssh-keygen -Y sign` and returns only
  the signature. **The private key never enters the agent container**, is never
  shown in the UI and is never written into a repository.
- The key's name and email become the commit's **committer**. The author stays
  the agent (`<agent-id>@agents.local`), so the loop protection and attribution
  that rely on the author are unchanged.
- Everything that creates a commit in a run is signed: `gh-as-agent commit`,
  plain `git commit`, `--amend`, `cherry-pick`, `rebase`, `merge` and the
  `knowledge` CLI. Platform commits are signed with the team's (or the global)
  key too: knowledge-base bootstrap, migration, heal and convergence commits and
  their rebases, and the pool-instance teardown commit.

## Set up a signing key

1. Open **SSH Keys → New key** (or follow a "Set up a signing key" link — it
   opens the form with signing switched on). Pick the scope: personal, a team,
   or global (System Admin).
2. Generate a key (recommended) or paste an existing ed25519/RSA private key.
3. Switch on **Sign agent commits with this key** and enter the commit name
   and email.
4. Copy the public key that is shown and add it on GitHub as a **Signing Key**:
   *Settings → SSH and GPG keys → New SSH key → Key type: Signing Key*. Add it
   to the account whose **verified email** is the commit email. GitHub only shows
   Verified when that email is verified on that account.

An existing SSH key can be turned into a signing key from its edit panel
(**Commit signing** section). That section also shows the public key again.
Legacy PEM keys cannot show their public key; derive it with
`ssh-keygen -y -f <key>`.

The **SSH Keys** and **GitHub Tokens** pages, and the team's **Effective GitHub
identity** box (Agent Chat → Settings), show a non-blocking hint while no signing
key is set up, and the box shows which key signs the team's commits.

## When something goes wrong

- **Signing fails** (key deleted, unreadable, orchestrator unreachable): the
  commit fails with an `aee-ssh-sign: … failed` message. A commit is never
  silently created unsigned.
- **The run could not read its signing config** (the orchestrator errored,
  timed out or could not be reached when the run started): every commit in that
  run fails with "could not read this run's commit-signing config … start a new
  run" — whether or not a key is configured, because the run cannot tell. Only
  an orchestrator that predates commit signing (no such route) leaves commits
  unsigned.
- **The key changed during a run** (rotated, replaced, signing switched off):
  the run's later commits fail and ask for a new run, so a run never switches
  identity half-way.
- **A push is rejected because commits are unsigned**: `gh-as-agent push` / `pr`
  report it with the code `unsigned-commits-rejected` and the fix (set up a
  signing key, then re-create the commits, e.g. with `git rebase --exec
  'git commit --amend --no-edit' <base>`).
- **A merge or branch update is rejected because commits are unsigned**
  (typically a pull request with commits pushed before enforcement):
  `gh pr merge` and `gh pr update-branch` print the same explanation after
  GitHub's error — the cause, the credential that lacks a signing key, the
  affected commits and the fix. gh's exit code is unchanged.

## Merging and updating pull requests

- `gh pr merge --merge` and `--squash`, and **Update branch** (`gh pr
  update-branch`), work unchanged: GitHub creates and signs those commits
  itself.
- **Rebase and merge is not supported** on branches that require signed
  commits: GitHub cannot sign the rewritten commits. Use merge or squash.

## Limitations

- Only SSH signing is supported, not GPG or S/MIME.
- A personal key with a signing identity that is also the first personal SSH
  key is used for git access too.
- Whether GitHub shows Verified depends on the GitHub side (key uploaded as a
  Signing Key, email verified). The platform cannot check that.
- Workflow commits are a separate concern: `tour-screenshots.yml` commits
  through the GraphQL `createCommitOnBranch` mutation, which GitHub signs.

## Kubernetes and pools

The signing request goes over the existing internal API (`:4002`) with the
agent's per-agent token, so it works the same on Podman and Kubernetes and for
pool instances. No extra mount, secret or network rule is needed.
