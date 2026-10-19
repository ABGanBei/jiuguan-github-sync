# 酒管 GitHub 同步

[中文](README.md) | English

Start with the [Chinese quick-start guide](docs/quickstart.md).

**1.4 unified setup wizard:** back up the current user's saved one-on-one character chat bodies to a dedicated private GitHub repository. On another device, check and stage updates, close all clients, then manually restart the service to apply them.

## Requirements and scope

- 酒管 **1.17.x**, **Node.js 20+**, npm, and Git. Back up and upgrade older 酒管 versions yourself; this installer does not upgrade the app.
- Only `chats/**/*.jsonl` one-on-one chat bodies are synced. Character cards, world books, group chats, attachments, and settings are excluded. Both devices need the same character cards, including matching actual card filenames.
- Upload covers all saved one-on-one chats for the current user. Checking updates only stages them. There is no online overwrite, force push, or deletion propagation.
- Conflicts preserve both copies for manual resolution. This version has no chat encryption or Git history cleanup.

## Install or upgrade

Download and extract this version from [the source repository](https://github.com/ABGanBei/jiuguan-github-sync), or clone it into a new directory. Close every 酒管 page and client and stop the service, then:

- **Windows: double-click `install.cmd`.**
- **Termux: run `bash setup.sh` from the source directory.**

Select the app directory, review the plan, and confirm. The wizard installs both frontend and backend, installs dependencies, and enables server plugins. Start the service yourself and open a fresh page afterward. Separate component installation is no longer required. Termux has not been verified on a real phone.

Recognized older releases are backed up before upgrading. The same version with matching contents needs no reinstall. Unknown, modified, or untracked old targets are rejected by default; explicit `--takeover` allows takeover only after a full backup. A same-name user-level extension overrides the shared extension; resolve that copy when the wizard reports it.

The CLI uses the same wizard. Interactive mode shows a plan before confirmation; an actual noninteractive install requires both `--apply` and `--stopped-confirmed`:

```text
node bin/setup.js --app-dir "APP_DIRECTORY"
node bin/setup.js --app-dir "APP_DIRECTORY" --config "ACTIVE_CONFIG_PATH" --data-root "ACTIVE_DATA_ROOT" --apply --stopped-confirmed
```

`--stopped-confirmed` is your declaration that every client is closed and the service is stopped. The wizard does not stop or restart the service automatically. Noninteractive installation requires an explicit data root; `--no-data-root` explicitly skips the shadow-extension check. Recovery or rollback with an external config also requires `--config "ORIGINAL_CONFIG_PATH"`.

For an interrupted installation, retain `<app-directory>/.jiuguan-install/`. Check status, then choose recovery or rollback as appropriate:

```text
node bin/setup.js --status --app-dir "APP_DIRECTORY"
node bin/setup.js --recover --app-dir "APP_DIRECTORY" --stopped-confirmed
node bin/setup.js --rollback --app-dir "APP_DIRECTORY" --stopped-confirmed
```

Recovery and rollback require the service to be stopped. Add `--to <backupId>` to select a rollback backup. Past backups are retained; the newer installation is moved to quarantine on rollback. See `node bin/setup.js --help` for more options.

## First-time configuration

1. Create a **dedicated Private data repository** on [GitHub](https://github.com/new), without a README, `.gitignore`, or License.
2. Create a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new). Choose **Only select repositories**, select **only that data repository**, and grant **Contents: Read and write**. Keep Metadata at its default read-only permission; no other permissions are needed.
3. Enter `owner/repo`, branch (default `main`), and the token in the panel, then click **保存并验证 (Save and verify)**. Both devices must use the same repository and branch, with an authorized token entered on each device.
4. If the branch is missing, review the target and confirm initialization separately. This makes one ordinary push containing no chats, without force-overwriting.
5. Review verification results, then upload or check updates.

**This public source repository must not be used for chats.** Private-repository and read verification confirm repository privacy and read access. Write access is confirmed only by a **successful real initialization or upload**. Permission settings and a successful read do not prove a push will succeed; branch protection or other rules may reject it.

The token field clears after saving and is never refilled. A blank field keeps the saved token. Repository and branch become locked once sync state exists; you can replace the token and verify again.

## Daily use

| Main action | Result |
| --- | --- |
| **上传已保存聊天 (Upload saved chats)** | Wait for generation and saving to finish, then upload saved on-disk chats. |
| **检查更新 (Check updates)** | Download and stage remote changes without rewriting active chats. |

When changing devices: upload successfully on the old device → check updates on the new one → review the staged list and pass **检查待更新项 (Check pending updates)** → close other clients and check the confirmation → **安排应用（重启后） (Schedule apply after restart)** → close the current page → **manually stop and restart the 酒管 service** → open a fresh page and confirm application status before continuing.

Preflight reflects the moment it runs; scheduling and startup validate again. A successful schedule does not mean chats have been applied. Refreshing a page does not restart the service. An upload result saying “remote update candidates, not downloaded” is not a persisted stage; use Check updates first.

Auto-check is off by default and appears in folded settings. When enabled, it only checks and stages periodically. It does not upload, overwrite online, or apply automatically, and preserves an already scheduled stage. Timers are not guaranteed while the service is off or the phone is asleep. The panel shows recent check, upload, and application records.

## Data and credentials

- Chats enter private-repository Git history in plaintext. Deleting current files does not remove old commits. Private access control does not provide end-to-end encryption.
- PATs use isolated secrets storage and `GIT_ASKPASS`, and do not enter ordinary configuration, logs, repositories, URLs, or process arguments. Token storage itself is not encrypted.
- Windows credential DACLs allow the current user, SYSTEM, and Administrators. Users have separate configuration, repositories, and locks.
- Application validates staged identity, contents, and local state, and backs up before writing. Conflicts or validation failures preserve data and block the operation. If a crash leaves no matching execution receipt, the schedule remains with an “unable to confirm” message; old history is not treated as proof of success.

## Verification limits

Verification includes installation, UI operations, staging, startup application, and continued chat saving in an official isolated 1.17 instance with synthetic chats and a local bare repository. Automated checks also cover installation transactions and frontend/backend safety gates. Evidence is provided with the relevant verification records.

**Real-user installation, Termux on a real phone, real GitHub PATs, real GitHub initialization over authenticated push, and end-to-end syncing of real chats remain unverified.** This documentation does not claim automatic service restart or deployment against real data. Back up first and rehearse in a separate test instance.

## Source

Based on [the original project by JOJO666888888](https://github.com/JOJO666888888/sillytavern-github-sync) (MIT License, original author retained). This repository adds a reliable sync core, the 酒管 UI integration, and the unified setup wizard.
