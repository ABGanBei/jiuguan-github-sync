# 酒管 GitHub 同步

[中文](README.md) | English

> This repository ships **two components in one repo**: a frontend extension (the in-app UI) and a server plugin
> (backend Git and file I/O). Install them into the JiuGuan (酒管) host **separately**. This is the
> **1.3.0-preview.1 UI-integration preview**: it syncs **one-on-one character chat bodies only** and does
> **no in-place online apply**. Read this fully, plus [docs/integration-contract.md](docs/integration-contract.md),
> before using it for real.

---

## What this is

This sync backs up **one-on-one character chat bodies** to your private GitHub repository and lets you retrieve them
safely across devices. It is **not** live overwriting sync: a pull only **stages** changes locally, and the real write
happens during the early window of the next startup — after you have closed every other client and tab.

**First-release limits (please understand)**:

- **One-on-one character chat bodies only** (`chats/**/*.jsonl`). Characters, worlds, group-chat bodies, knowledge,
  settings, etc. are **not synced**; both ends must have the **same characters** configured or chats won't line up.
- **No online apply**: there is no "download overwrites my chat now" button; download only stages.
- **No force push / force pull**: remote or local history is never force-overwritten.
- **Deletes do not propagate**: deleting a chat on one side does not spread to the other.
- **Conflicts keep both sides**: nothing is auto-picked; both copies are kept for you to resolve manually.

## Installation (two components)

Two pieces in one repo, installed separately. **For first install**, `git clone` this repo and `cd` into it first,
then follow the two steps below.

> This is a **public plugin source repository** (`github.com/ABGanBei/jiuguan-github-sync`); for chat sync, **create a
> separate dedicated private data repository** — the **Repository field must not point at this source repo**.

### 1. Frontend extension (the in-app UI)

In the JiuGuan (酒管) "Extensions" UI, install by **extension URL** and paste this repository's Git URL:
`https://github.com/ABGanBei/jiuguan-github-sync.git`. The exact entry point depends on your JiuGuan (酒管) version.

### 2. Server plugin (backend)

Inside the cloned repo, run the one-shot Node installer to install the plugin into the host's `plugins/` directory
and enable server plugins:

```bash
git clone https://github.com/ABGanBei/jiuguan-github-sync.git
cd jiuguan-github-sync
node bin/install-plugin.js --app-dir <app-dir> --enable-server-plugins --install-deps --apply
```

- It **defaults to dry-run**: without `--apply` it only prints the exact source/target/config plan and writes nothing.
  Actual installation requires explicit `--apply`; review the plan **without `--apply` first**, then run with it.
- `--enable-server-plugins` flips `config.yaml`'s `enableServerPlugins` from `false` to `true` (idempotent).
- `--install-deps` runs `npm ci --omit=dev` inside the new plugin directory.
- Runs under Windows PowerShell; Termux support is **design + synthetic path tests only** and is **not yet
  verified on a real phone** (the installer is pure Node — see "Verification status").

> After installing, **close all old tabs → stop the JiuGuan (酒管) service → restart it → reopen a fresh page**, so the
> new frontend extension and backend plugin load correctly.

### 3. Configure

In the extension UI:

- **Repository**: `owner/repo` (the **dedicated private data repository you create for chat sync** — **do not point it at
  this public source repo**); **Branch**: `main` (or yours).
- **PAT**: paste a personal access token. The token is **written only** to an isolated secrets store (never to
  settings/logs/repo/URL/process args); the frontend **never re-fills** a saved token; leaving it blank keeps the
  existing token unchanged.
- First-time: you may check **initialize empty branch** — only when explicitly checked does it bootstrap an empty
  repository with one normal push (**no force**).

### Privacy (read before using)

- **Use a dedicated private data repository**; do not sync chats into any other code/doc repo.
- **Use a fine-grained PAT** and grant **only this repository's `Contents` read/write** (`Metadata` is implicitly
  read-only on GitHub — no extra grant needed). You do **not** need organization/account or other-repo scopes, and you
  should **not** use a classic full-repo-scope token.
- Confirm the repository is **not protected by a ruleset** that blocks ordinary push (otherwise pushes are rejected).
- **Private-repo access control ≠ end-to-end encryption**: chats enter Git history in **plaintext**; deleting a file
  does **not** delete its content from older commits.
- This version has **no encryption, no history cleanup, and no old-version GUI recovery**; if you need strong privacy
  or encryption, do not sync real data yet.

## UI actions

| Action | Meaning |
|--------|---------|
| Save | Writes repo/branch/auto-check settings and PAT (PAT written only to isolated secrets, never re-filled, blank keeps it) |
| Connect | Tests repo and token; optionally "initialize empty branch" |
| Upload saved chats | Pushes already-saved on-disk chats to the remote |
| Check download | Pulls from remote and **only stages**, never writes chats |
| Schedule restart-apply | Binds the current stage + target identity/digest, scheduled to apply at next startup; requires **closing all clients and reopening after restart** |
| Cancel schedule | Clears only the schedule, never deletes staged backups |

**Auto-check** is **off** by default; when on, it only periodically `pull`s and stages — it **never auto-applies**.
Timers are not guaranteed to run while the app is closed or the phone is asleep.

## Actually applying chats (at restart)

The early startup window is the only safe time to write chats, so a scheduled apply is never "invisible in-place overwrite":

1. In the UI, click **Schedule restart-apply**, confirming you will **close all other clients and old tabs** before restarting.
2. **Stop the JiuGuan (酒管) service.**
3. Start JiuGuan (酒管) again; within the official 1.17 `loadPlugins` await window, before `listen`, the plugin verifies the
   same stage/identity/digest and then writes.
4. Reopen the browser tab.

If verification fails (stage/identity mismatch, chat already changed, etc.), the plugin keeps the original intent and
baseline and never rewrites the expectation from current content; a partial write blocks the host from continuing to
start, avoiding a half-written state.

**Receipt narrow-window limit**: in the crash window after apply has completed (stage/active cleared) but before the
receipt is persisted, the chat data has actually been written, yet on the next startup the plugin **cannot confirm**
that apply finished — it keeps the schedule and reports "cannot confirm, may cancel in the UI", and it **never guesses
success from historical complete records**. This is an intentional product limit (prefer manual confirmation over a
false success or permanently blocking the whole host).

## Security bounds

- Credentials go through `GIT_ASKPASS`; the PAT never enters config, settings, logs, the repo, URLs, or process args;
  on Windows it is tightened via a DACL to **current user / SYSTEM / Administrators** (and inherited + other explicit
  wide-read ACEs are removed) — not "current user only".
- Git/core run in a dedicated worker that clears inherited token/GIT config/askpass/SSH variables and disables
  interactivity; storage paths reject symlinks/junctions/escaping.
- Per-user config, repo, and lock.

## Verification status

- **Verified (official isolated host + synthetic data + local bare)**: on the official 1.17 isolated host (pinned commit
  `e3f41666c69db032e17e079fcddcf40cf47e8593`), the frontend extension installed its manifest/client over an extension URL
  from a local Git fixture; the real Node backend installer `--apply --install-deps` enabled and backed up config; the real
  UI saved a synthetic token then cleared without re-fill, CSRF-connected and bootstrapped a local bare, and pushed; on the
  other end synthetic main/branch edits were made, pull only staged (disk unchanged); UI scheduled, closed all old tabs,
  stopped the service, applied before `listen` on restart, a fresh tab loaded the mainline second candidate 2/2, and `/send`
  appended a user message successfully; a subsequent UI push made the bare remote file **byte-identical** to the host's
  saved bytes, with `swipes2`/`swipe_id1`/`swipe_info`/`peerNote` all preserved (evidence in the separate verification
  evidence package `host-continued-evidence.json`, provided by Codex as an evidence ZIP — **not shipped with this source
  package**); a real chat-manager opened the sync-branch body and `/checkpoint-exit` back to
  the mainline succeeded (these branch scenarios are scoped to that synthetic main/branch sample only — **not** a claim
  that every branch scenario is verified). The auto-check timer's backoff and restart-recovery have been verified with a
  controllable clock.
- **Not verified**: real-user install, a real phone (Termux on-device), a real GitHub PAT, and the real GitHub bootstrap
  HTTP-auth push are all **not verified** — do not use in production. Termux support is currently design + synthetic path
  tests only, not on a real device.
- **App closed / phone asleep** does not guarantee timers run.
- This repo does **not** claim to be deployed against real data; the **source is public**
  (`github.com/ABGanBei/jiuguan-github-sync`), but "source published" and "real-data sync verified" are **different
  things** — end-to-end sync of real chat data on real GitHub is **not yet verified**. Per-suite pass counts are not
  hard-coded here — they come from Codex's measured evidence.
- This repo does **not** claim encryption: tokens are kept in an isolated secrets store and passed via `GIT_ASKPASS`
  (never in logs/URL/args), but they are not stored encrypted.
- Windows credentials are tightened via a DACL to current user / SYSTEM / Administrators (SID); no stricter POSIX-style
  semantics apply.

## Source

Based on [JOJO666888888/sillytavern-github-sync](https://github.com/JOJO666888888/sillytavern-github-sync)
(MIT License, author retained). This repo adds a "reliable sync core" and a "1.17 UI integration" on top; the original
body is retained here only as source and MIT attribution.
