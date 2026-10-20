# ParallelBrowser Architecture

## Resource allocation

`SessionConfig` validates `cpuCores` (1–8) and `memoryLimitMB` (1024–8192). Defaults are 4 cores/4096 MiB. `DockerService` checks engine capacity, then sets `NanoCpus`, `Memory` and a bounded memory-plus-swap limit. Allocation remains a ceiling and does not reserve unused memory. Host Settings persist as validated JSON in the app user-data directory and apply to the next workspace. No passwords or session tokens are saved there.

## Current transport implementation

The client connects to `/control` for invitation authentication and host approval. On approval the host consumes the invitation and returns a short-lived-by-session stream bootstrap URL. That URL sets an HttpOnly stream cookie and redirects to `/`. The Electron client embeds the KasmVNC web viewer, which handles actual rendering, mouse and keyboard input. The host proxies authenticated HTTP resources and WebSocket upgrades to the container's HTTPS KasmVNC endpoint, supplying backend Basic credentials. The display proxy terminates both WebSocket hops with protocol-aware ping/pong every 15 seconds, preserves text/binary frames and applies send-callback backpressure. It disables extra WebSocket compression because Kasm already compresses image data. Raw TCP RFB relay and the placeholder canvas are no longer used. Stopping the session or disconnecting the client revokes the cookie and closes existing stream connections.

Internet mode routes HTTPS/WSS through the bundled cloudflared Quick Tunnel to a random loopback listener. A detached worker closes its owned tunnel on Host exit or IPC loss. Startup probes the public endpoint against a random instance proof before exposing invitations. Internet invitations use the explicit `PB2-` secure marker; legacy codes remain LAN-only. The Client validates the approved viewer origin against its invitation and never downgrades HTTPS.

Client file transfers use native file dialogs and streams in the client main process. The approved stream credential authenticates fixed `/api/files/` operations on the existing host port. The host replaces that credential with a separate per-container secret and streams requests to a small Python file service on container port 9090, published only to host loopback. That service runs as UID 1000 and confines uploads/downloads to the workspace's two folders, without host mounts. Internet uploads use ordered 4 MiB requests to avoid relay body limits; LAN uploads use one streamed PUT. Uploads are streamed into temporary files and published with collision-safe names; local saves are renamed into the user-selected destination only after successful completion. Client disconnect and host stop close active transfer requests. The native client needs no Python or Docker installation.

| Client action | Flow |
| --- | --- |
| Upload from this PC | Native picker → client file stream → authenticated host proxy → workspace Uploads |
| Website upload | Remote browser file picker → workspace Uploads → website |
| Browser download | Website → workspace Downloads |
| Save to this PC | Native save dialog → authenticated host proxy → workspace file stream → client destination |

## System Architecture

```text
Client EXE -- HTTPS/WSS --> Cloudflare Quick Tunnel
                                  | encrypted outbound tunnel
Host EXE <-- random loopback port -- bundled cloudflared
    | authenticated HTTP / WebSocket proxy
    +--> loopback Docker KasmVNC --> isolated Chrome / X11
    +--> loopback file service --> workspace Uploads / Downloads
Private host setup --> separate authenticated loopback listener
```

The Client sees only the container display. Cloudflare terminates TLS. Local network mode bypasses the tunnel and uses HTTP/WebSocket on port 9500. See [internet sharing](internet-sharing.md).

## Component Details

### Host Application (`host-app/`)

| Component | File | Responsibility |
|-----------|------|---------------|
| Main Process | `src/main/index.ts` | Electron lifecycle, IPC handlers, service coordination |
| Preload | `src/main/preload.ts` | Secure IPC bridge between main and renderer |
| Docker Service | `src/services/docker-service.ts` | Container lifecycle, image management, resource monitoring |
| Session Manager | `src/services/session-manager.ts` | Session state, token generation, config management |
| WebSocket Server | `src/services/websocket-server.ts` | Client connections, auth, VNC relay |
| Internet Tunnel | `src/services/internet-tunnel.ts`, `tunnel-worker.ts` | Verified bundled helper, readiness probe and owned-process cleanup |
| Dependency Checker | `src/services/dependency-checker.ts` | Docker/WSL detection |
| Renderer | `src/renderer/` | Dashboard UI (vanilla HTML/CSS/JS) |

### Client Application (`client-app/`)

| Component | File | Responsibility |
|-----------|------|---------------|
| Main Process | `src/main/index.ts` | Electron lifecycle, IPC handlers |
| Preload | `src/main/preload.ts` | Secure IPC bridge |
| Connection Service | `src/services/connection-service.ts` | WebSocket connection, auth, VNC data relay |
| Renderer | `src/renderer/` | Connection UI + VNC viewer canvas |

### Shared Library (`shared/`)

| Module | File | Contents |
|--------|------|---------|
| Types | `src/types.ts` | Session, config, dependency interfaces and enums |
| Protocol | `src/protocol.ts` | WebSocket message types and serialization |
| Crypto | `src/crypto.ts` | Token generation, HMAC verification, invitation codes |

## Connection and input flow

1. Host creates its owned Docker workspace. KasmVNC and file service ports are published only to loopback.
2. Internet mode starts a random loopback Host listener plus the bundled tunnel. Host verifies the public HTTPS endpoint. Local mode instead listens on LAN port 9500.
3. After any private setup, Host creates an expiring invitation containing an address and random authentication token.
4. Client opens WSS for a secure invitation, or WS for a legacy LAN invitation, at `/control` and submits the token.
5. Host validates the token, displays the pending request and waits for manual approval. Until approval, browser and file requests receive 403.
6. Approval consumes the invitation and issues a separate random stream token. Client validates the stream origin against its invitation and attaches an isolated KasmVNC webview.
7. A bootstrap request establishes the HttpOnly stream cookie. Subsequent authenticated HTTP assets and WebSocket upgrades are proxied to KasmVNC with private backend credentials.
8. KasmVNC's web viewer sends input over its WebSocket to the container display. Chrome handles the input inside X11 and returns framebuffer updates. Windows desktop input APIs are never called.
9. Disconnect revokes access and closes active stream/file connections. Imported-profile sessions also remove their temporary workspace. Host stop closes the tunnel and removes its workspace.

## Profile preparation and lifetime

`ChromeProfiles` catalogs the host Windows user's Chrome profiles and, after native host approval, builds a portable bookmark/preferences snapshot. `profileArchive` creates an in-memory archive with fixed paths for Docker's default user template before container startup. Password/cookie databases and encryption keys are excluded.

`SessionManager` gates invitations behind private setup for imported profiles. `WebSocketServer.openHostSetup` creates an authenticated loopback-only HTTP/WebSocket proxy into the same workspace; its token is separate from all client tokens. The main process opens a sandboxed viewer without a preload or Node integration, in an ephemeral partition. The host signs in and confirms readiness; the private viewer is revoked and closed before invitations are enabled. Client connection still requires explicit host approval.

Imported-profile data lives only in the owned temporary container. Client disconnect ends this session and normal stop removes the container plus anonymous volumes. A detached `cleanup-worker` is started and checked before import and watches the parent IPC channel, removing its exact container if the host crashes. It retries if Docker is temporarily unreachable. Both fresh and imported-profile sessions support bounded recovery of the same approved client. During a control interruption display/file access is denied; successful recovery retains browser tabs and the viewer partition. Expiry permanently revokes credentials and removes imported-profile workspaces. Fresh workspaces can remain available for a new host invitation.

The client main process assigns each approved connection a random in-memory Electron partition and validates it when the renderer attaches the guest. Disconnect destroys that guest, clears its partition data/cache and displays a blank inactive viewer. Subsequent connections use a fresh partition; cleanup does not block reconnect or run against the new partition.

## Technology Choices

| Choice | Technology | Rationale |
|--------|-----------|-----------|
| Container | Docker + kasmweb/chrome | Battle-tested isolation, maintained image, built-in VNC |
| Internet transport | Bundled cloudflared Quick Tunnel | No client installation, account or port forwarding; best-effort preview service |
| Desktop Framework | Electron | Cross-platform, native installers, embedded web views |
| Language | TypeScript | Type safety, refactoring support, modern JS features |
| Display protocol | KasmVNC web viewer | Authenticated HTTP assets and WebSocket upgrades; independent container input |
| UI | Vanilla HTML/CSS/JS | No build complexity for renderer, fast iteration |
| Installer | electron-builder + NSIS | Industry standard for Electron Windows installers |
