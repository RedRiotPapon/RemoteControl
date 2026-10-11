# ParallelBrowser Setup Guide

## Prerequisites

### Required Software

#### 1. Docker Desktop (Host PC Only)

Docker Desktop runs the isolated Chromium browser container.

**Install:**
1. Download from https://www.docker.com/products/docker-desktop/
2. Run the installer (requires admin privileges)
3. Choose **WSL 2 backend** when prompted
4. Restart your PC if required
5. Launch Docker Desktop and wait for it to start

**Verify:**
```powershell
docker --version
# Expected: Docker version 24.x or later

docker info
# Should show "Server: ..." with no errors
```

#### 2. Tailscale VPN (Both PCs — for Internet Connections)

Tailscale creates an encrypted tunnel between your PCs without port forwarding.

**Install:**
1. Download from https://tailscale.com/download
2. Install on BOTH the host PC and client PC
3. Sign in with the same Tailscale account (or share a Tailnet)
4. Note your Tailscale IP addresses

**Verify:**
```powershell
tailscale status
# Should show your device with an IP like 100.x.y.z
```

> **Note:** Tailscale is not required for LAN connections. If both PCs are on the same local network, you can use local IP addresses. However, Tailscale is strongly recommended for internet connections as it provides encryption.

#### 3. Node.js and npm (For Building from Source)

**Install:**
1. Download from https://nodejs.org/
2. Install the LTS version
3. Verify: `node --version`

### First-Time Image Pull

The first time you start a browser session, Docker downloads `kasmweb/chrome:1.15.0` if it is missing. This is a large download; the host dashboard displays progress. Subsequent starts reuse the downloaded image, but still wait for the browser and file service to become ready.

## Installation

### Option A: From Installers

1. Run `ParallelBrowser-Host-Setup.exe` on the host PC
2. Run `ParallelBrowser-Client-Setup.exe` on the client PC

For a client who wants to avoid installation, download **ParallelBrowser-Client-Portable.exe** from [GitHub Releases](https://github.com/RedRiotPapon/RemoteControl/releases/latest) and double-click it. Enter a name, paste the host's invitation and click **Connect**. The portable client bundles its runtime and does not need Docker, Node.js or Python. It may take a moment to extract and open. The optional Client Setup EXE performs a one-click per-user installation and opens the app when finished.

The host still needs Docker Desktop. For different networks, the host should help the client connect through Tailscale once; the client app does not supply an internet relay. Windows may show a publisher warning because the current binaries are unsigned.

### Option B: From Source

```powershell
# On the host PC
cd ParallelBrowser
npm run install:all
npm run build:all
npm run start:host

# On the client PC (copy the project or install separately)
cd ParallelBrowser
npm install --prefix shared
npm install --prefix client-app
npm run build:shared
npm run build:client
npm run start:client
```

## Host and client workflow

1. On the host, complete the dependency check and choose **Fresh browser** or an existing Windows Chrome profile. The profile list belongs to the Windows user running the Host app.
2. Click **Start Browser**. For a profile, review the native permission dialog and select **Allow temporary copy**. Cancelling does not copy the profile.
3. For a selected profile, open **Private setup** and sign into the required Google account or websites yourself. Only bookmarks and basic settings are imported automatically; existing cookies, passwords, history, autofill and extensions are excluded.
4. Return to the Host app, click **I've finished setup**, and confirm **Ready for client**. Merely closing the setup window does not enable invitations. Fresh browsers may also be prepared privately.
5. In **Invite a client** at the top, click **2. Generate Invitation**, then **Copy invitation** and send the complete code to the intended client. It expires after 60 minutes and is consumed after one approved connection. This is a code to paste into the Client app, not a clickable join link. While the session is **Idle**, start the browser first; while private setup is required, finish that first.
6. On the client PC, enter a name, paste the invitation and select **Connect**. The host must approve the connection before the browser appears. The client can then use the host-prepared signed-in websites without receiving the host's password.
7. Continue using the host desktop normally. Client input affects the isolated browser display. Installed Windows programs and the original running Chrome window are not shared.

For imported profiles, disconnecting the active client ends the session and removes its temporary workspace. **Stop Browser**, host quit and the duration limit also remove the workspace. A cleanup helper handles abrupt host termination and retries if Docker is unreachable. The original host profile remains unchanged; a new profile session needs fresh host permission and manual sign-in. A fresh-browser session can remain running after disconnect until the host stops it.

### Files on the client's PC

- Select **Upload from this PC**, choose local files (at most 1 GiB each), then select those copied files from **Uploads** in the website's remote file picker.
- Download normally in the remote browser. Open the Client app's **Downloads** list, refresh if needed, and select **Save to this PC** to choose a local destination.
- Transfers show progress and can be cancelled. Files explicitly saved to the client's PC remain there after the remote session ends. Temporary workspace uploads and downloads are removed with that workspace.

## Configuration

### Host Settings

Access via the gear icon in the header:

| Setting | Default | Description |
|---------|---------|-------------|
| Browser Width | 1920 | Chromium viewport width |
| Browser Height | 1080 | Chromium viewport height |
| Max Duration | 480 min | Auto-stop after this duration (0 = unlimited) |

### Network Configuration

The host WebSocket server runs on port **9500** by default.

Allow TCP port 9500 between the intended PCs through Windows Firewall if it is blocked. Limit access to the trusted LAN or Tailscale interface. Tailscale provides encrypted transport between connected PCs; ordinary LAN mode uses HTTP/WebSocket without TLS. Do not forward port 9500 directly from the public internet.

## Troubleshooting

### "Docker is not running"
- Open Docker Desktop and wait for it to fully start
- Check that WSL 2 is enabled: `wsl --status`
- For an inaccessible `dockerInference` or `engine.sock` endpoint, see [runtime socket recovery](docker-recovery.md). Do not reset Docker workload data as the first recovery step.

### "Failed to start browser"
- Ensure Docker has enough resources (Settings → Resources)
- Try pulling the image manually: `docker pull kasmweb/chrome:1.15.0`
- Run `docker ps -a --filter name=parallelbrowser-session` to find the exact workspace name, then run `docker logs <exact-workspace-name>`.

### "Connection refused" or "Cannot connect"
- Verify both PCs are on the same Tailscale network or LAN
- Check that the host's WebSocket server is running (green status in host app)
- Ensure no firewall is blocking port 9500
- Try `ping <host-tailscale-ip>` from the client PC

### "Invalid invitation code"
- Invitation codes expire after 60 minutes
- Generate a new code from the host app
- Ensure the full code was copied (no truncation)

### "Approval timeout"
- The host must explicitly approve the connection
- Ensure the host app is visible and the host user can see the approval prompt

### "Finish private host setup" or disabled invitation button

- Open **Private setup**, complete any sign-in yourself, then click **I've finished setup** in Host and confirm readiness.
- The host still has to approve the client's connection after this step.
- Reopening private setup revokes the previous invitation. Generate a new invitation after finishing it again.

### Profile unavailable or import failed

- Refresh the profile list and select a profile available to the current Windows user.
- If Chrome is updating its bookmarks/settings while they are read, close Chrome and retry.
- Profile import is limited to portable bookmarks and settings. Sign-in sessions are not automatically migrated from Windows Chrome.

### Container won't stop

Retry **Stop Browser** after Docker is available. If manual cleanup is necessary, identify the specific failed workspace and remove only that container:

```powershell
docker ps -a --filter name=parallelbrowser-session
# Replace the placeholder with the exact workspace you intend to end.
docker rm -f -v <exact-workspace-name>
```

This deletes that workspace's temporary browser data. Do not remove containers belonging to another active Host instance.
