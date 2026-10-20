# ParallelBrowser 1.1.1

This update addresses interruptions, repeated manual reloads and browser resource limits. **Update both Host and Client**, then start a new session and generate a fresh invitation. Docker remains on the Host; the Client still needs only its EXE.

- Display WebSockets now have ping/pong keepalives on the internet hop to avoid idle relay closures.
- Brief control drops recover automatically for up to one minute, using a separate credential for the same approved session. Host approval is still required for each new session.
- A broken display automatically reconnects with bounded backoff. Browser tabs and website state remain open.
- Client **Display → Low data / Balanced / Sharper** controls image quality and frame rate. **Refresh view** reconnects the display without reloading the remote website.
- Browser capacity defaults increase from **2 CPU cores / 2 GB RAM to 4 cores / 4 GB RAM**. Host **Settings** can adjust both from 1–8, saves changes across app launches and checks Docker capacity before creating a workspace.
- Background display throttling is disabled; upgraded connections no longer inherit HTTP inactivity timeouts.

## Windows downloads

- **ParallelBrowser-Client-Portable.exe** — recommended, double-click and connect.
- **ParallelBrowser-Client-Setup.exe** — optional per-user installation.
- **ParallelBrowser-Host-Setup.exe** — install on the PC providing Docker Chrome.
- **SHA256SUMS.txt** — checksums.

Windows x64, unsigned builds. No VPN or extra networking installation is required.

## Recovery and cleanup

During a control interruption, browser/file access is paused. Recovery retains the same temporary browser and client viewer partition. Host Stop/Disconnect immediately cancels recovery. If recovery fails for a minute, credentials expire; an imported-profile workspace is removed. Explicit Client Disconnect revokes access when reachable; an offline peer is cleaned up after its bounded grace window. File transfers interrupted by a drop must be restarted. New sessions still require fresh invitations, approval and any required host profile permission/sign-in.

Cloudflare Quick Tunnels remain a best-effort preview service with no uptime SLA; Cloudflare terminates TLS. Additional computing capacity cannot eliminate network distance or limited host upload bandwidth. Existing Windows programs and host Chrome sign-in cookies/passwords are not shared.

See [recovery validation](https://github.com/RedRiotPapon/RemoteControl/blob/main/docs/recovery-validation.md) and [internet sharing](https://github.com/RedRiotPapon/RemoteControl/blob/main/docs/internet-sharing.md).
