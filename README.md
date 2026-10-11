# ParallelBrowser

A two-application system that allows a remote user to control an isolated Chromium browser running on your Windows PC, without interfering with your desktop.

## Overview

- **ParallelBrowser Host** — Runs on your Windows 11 PC. Manages an isolated Chromium browser inside a Docker container.
- **ParallelBrowser Client** — Runs on the remote user's Windows PC. Connects securely and displays the isolated browser.

## Key Features

**Current scope:** this release shares a temporary Linux Chrome workspace. Hosts can select an existing Windows Chrome profile and authorize a session-only copy of web bookmarks and basic settings. The host signs in privately before inviting the client. Existing Windows cookies/passwords and installed Windows programs are not transferred. See the [usability review and Windows workspace plan](docs/usability-review.md) for remaining requirements.

- **Complete isolation**: The browser runs in a Docker container with its own display — never touches your desktop
- **Independent input**: Remote keyboard and mouse only affect the container browser, never your Windows session
- **Remote transport**: Tailscale VPN encrypts traffic between PCs; trusted LAN mode uses HTTP/WebSocket without TLS
- **Host approval**: You explicitly approve or reject every client connection
- **Private profile setup**: Profile import needs host permission; the host signs in before the client can connect
- **Session-only profile data**: Disconnecting a client ends an imported-profile session and removes its workspace
- **One-click management**: Start/stop browser, generate invitations, disconnect clients

## Quick Start

### Download and run — no coding required

Get the Windows EXEs from [GitHub Releases](https://github.com/RedRiotPapon/RemoteControl/releases/latest).

- **Client (recommended):** download **ParallelBrowser-Client-Portable.exe** and double-click it. Enter your name, paste the host's invitation, then click **Connect**. No installation wizard, Docker or Node.js is needed on the client PC.
- **Client (installed):** use **ParallelBrowser-Client-Setup.exe** for one-click installation and launch.
- **Host:** use **ParallelBrowser-Host-Setup.exe** on the PC providing the browser. Docker Desktop is required on the host only.

The PCs must share a reachable local network, or both have Tailscale configured for an internet connection. The host should handle that one-time network setup for a nontechnical client. These Windows x64 builds are unsigned, so Windows may show a publisher warning. See the [download instructions](docs/release-notes.md).

### Prerequisites

1. **Docker Desktop** with WSL2 backend — [Download](https://www.docker.com/products/docker-desktop/)
2. **Tailscale** (for internet connections) — [Download](https://tailscale.com/download)
3. **Node.js and npm** (only for building from source) — [Download](https://nodejs.org/)

### Build from Source

```powershell
# Clone and install
git clone https://github.com/RedRiotPapon/RemoteControl.git
cd RemoteControl
npm run install:all

# Build everything
npm run build:all

# Run host
npm run start:host

# Run client (on another PC)
npm run start:client
```

### Build Installers

```powershell
npm run dist:all
```

Installers will be in:
- `host-app/release/ParallelBrowser-Host-Setup.exe`
- `client-app/release/ParallelBrowser-Client-Setup.exe`
- `client-app/release/ParallelBrowser-Client-Portable.exe`

## Usage

### Host Workflow
1. Open ParallelBrowser Host
2. Complete the dependency check (Docker + Tailscale)
3. Select **Fresh browser** or one of your Windows **Chrome profiles**, then click **Start Browser**. For a profile, review and authorize the temporary copy in the native confirmation dialog.
4. For a profile, click **Open private setup**, sign in yourself in that browser window, then return to Host and click **I've finished setup**. Confirm that it is ready for the client. Invitations stay blocked until you finish. You can also privately prepare a fresh browser.
5. Click **Generate Invitation** and share the one-time code with the remote user.
6. **Approve** or **Reject** the client's connection when prompted. Approval gives control of the prepared browser, including its signed-in websites.
7. Continue using your PC normally. **Stop Browser** removes the temporary workspace. For imported profiles, client disconnect also ends and removes the workspace; a new session requires fresh host permission and sign-in.

Only HTTP/HTTPS bookmarks, the homepage, bookmark-bar visibility and profile display name are imported. History, extensions, autofill, saved passwords, Windows encryption keys and existing sign-in cookies are excluded. The original Chrome profile is read only. Workspace data stays inside Docker on the host PC; it is not installed as a Chrome profile on the client's PC. Explicitly downloaded files saved by the client remain on their PC. Container removal is normal application cleanup, not a promise of forensic secure erasure or deletion of data held by websites.

### Client Workflow
1. Open ParallelBrowser Client
2. Enter your name and paste the invitation code
3. Click **Connect** and wait for host approval
4. Use the browser inside the container. Ask the host for a new invitation after disconnecting.

### Client files

- **Upload from this PC** opens the client's Windows file picker. Select one or more files, up to 1 GiB each. They are copied into the remote browser's **Uploads** folder. When a website asks for a file, open **Uploads** in the remote file picker and choose it. Existing uploads are preserved with numbered names when a name is repeated.
- Download normally inside the remote browser. Click **Downloads**, then **Save to this PC**, and choose a local destination. The list includes completed files from the remote **Downloads** folder; use **Refresh list** after a new download finishes. A cancelled or interrupted save leaves the existing local destination unchanged.
- Transfer progress and cancellation appear above the browser. Transfers use chunks rather than buffering entire files in memory. Uploads and remote downloads remain in the temporary workspace until the host stops it; files saved to the client's PC remain there.
- Update **both Host and Client** to use file transfer. The host needs the supplied Chromium image with Python 3 and the standard `/home/kasm-user` home directory. The client needs neither Docker nor Python.

## Verification

```powershell
npm run build:all
npm test
```

For Electron UI checks, set `PLAYWRIGHT_MODULE` to an installed Playwright module and run `node scripts/ui-smoke.js`. By default this uses a mock workspace. Set `PB_QA_REAL=1` to exercise Docker/Kasm Chromium, including real remote keyboard and mouse input. The real check needs Docker running and the configured image available. Each run stops and removes its own test workspace.

Run `node scripts/ui-file-smoke.js` with the same Playwright setting for real file transfer checks. It exercises the toolbar and IPC with QA-only native-dialog stubs, selects the uploaded file through Chromium's remote file picker, submits it to a local test website, downloads its response, and verifies the bytes saved on the client PC. It creates and removes its own workspace and local temporary files.

Set `PB_QA_PACKAGED=1` for this file test to launch the rebuilt `release/win-unpacked` executables instead of the source builds.

Run `node scripts/ui-profile-smoke.js` for profile consent, private host sign-in, invitation gating, approved client access, disconnect cleanup and forced-host-termination cleanup. This uses a synthetic profile and local test website, never the host's real bookmarks or accounts. `PB_QA_PACKAGED=1` also supports this test.

## Architecture

See [docs/architecture.md](docs/architecture.md) for detailed architecture documentation.

## Documentation

- [Setup, host/client workflow and troubleshooting](docs/setup.md)
- [Capabilities, test evidence and remaining Windows app support](docs/usability-review.md)
- [Repository, build verification and release guide](docs/github.md)
- [Docker Desktop runtime socket recovery](docs/docker-recovery.md)

## Security

See [docs/security.md](docs/security.md) for security model and limitations.

## License

[MIT](LICENSE)
