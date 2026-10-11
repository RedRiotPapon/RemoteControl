# ParallelBrowser Architecture

## Current transport implementation

The client connects to `/control` for invitation authentication and host approval. On approval the host consumes the invitation and returns a short-lived-by-session stream bootstrap URL. That URL sets an HttpOnly stream cookie and redirects to `/`. The Electron client embeds the KasmVNC web viewer, which handles actual rendering, mouse and keyboard input. The host proxies authenticated HTTP resources and WebSocket upgrades to the container's HTTPS KasmVNC endpoint, supplying backend Basic credentials. Raw TCP RFB relay and the placeholder canvas are no longer used. Stopping the session or disconnecting the client revokes the cookie and closes existing stream connections.

The historical raw-VNC diagrams below describe the original prototype, not the current transport. See [the usability review](usability-review.md) for the Windows workspace requirement and outstanding work.

Client file transfers use native file dialogs and streams in the client main process. The approved stream credential authenticates fixed `/api/files/` operations on the existing host port. The host replaces that credential with a separate per-container secret and streams requests to a small Python file service on container port 9090, published only to host loopback. That service runs as UID 1000 and confines uploads/downloads to the workspace's two folders, without host mounts. Uploads are streamed into temporary files and published with collision-safe names; local saves are renamed into the user-selected destination only after successful completion. Client disconnect and host stop close active transfer requests. The native client needs no Python or Docker installation.

| Client action | Flow |
| --- | --- |
| Upload from this PC | Native picker → client file stream → authenticated host proxy → workspace Uploads |
| Website upload | Remote browser file picker → workspace Uploads → website |
| Browser download | Website → workspace Downloads |
| Save to this PC | Native save dialog → authenticated host proxy → workspace file stream → client destination |

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     HOST PC (Windows 11)                      │
│                                                               │
│  ┌─────────────────────┐    ┌────────────────────────────┐   │
│  │  ParallelBrowser     │    │  Docker Desktop (WSL2)      │   │
│  │  Host App            │    │                              │   │
│  │  (Electron)          │    │  ┌────────────────────────┐ │   │
│  │                      │────│─>│  kasmweb/chrome         │ │   │
│  │  • Session Manager   │    │  │  Container              │ │   │
│  │  • Docker Service    │    │  │                          │ │   │
│  │  • WebSocket Server  │    │  │  • Chromium Browser      │ │   │
│  │  • Auth/Token Mgmt   │    │  │  • KasmVNC Server        │ │   │
│  │                      │    │  │  • Virtual X11 Display   │ │   │
│  └────────┬─────────────┘    │  └────────────────────────┘ │   │
│           │                   └────────────────────────────┘   │
│           │ WebSocket (port 9500)                              │
│           │ Binds to Tailscale IP or 0.0.0.0                  │
└───────────┼──────────────────────────────────────────────────┘
            │
            │  Encrypted tunnel (Tailscale/WireGuard)
            │  or LAN connection
            │
┌───────────┼──────────────────────────────────────────────────┐
│           │                  CLIENT PC (Windows)              │
│  ┌────────┴─────────────┐                                    │
│  │  ParallelBrowser      │                                    │
│  │  Client App           │                                    │
│  │  (Electron)           │                                    │
│  │                       │                                    │
│  │  • Connection Service │                                    │
│  │  • VNC Viewer Canvas  │                                    │
│  │  • Input Handler      │                                    │
│  └───────────────────────┘                                    │
└──────────────────────────────────────────────────────────────┘
```

## Component Details

### Host Application (`host-app/`)

| Component | File | Responsibility |
|-----------|------|---------------|
| Main Process | `src/main/index.ts` | Electron lifecycle, IPC handlers, service coordination |
| Preload | `src/main/preload.ts` | Secure IPC bridge between main and renderer |
| Docker Service | `src/services/docker-service.ts` | Container lifecycle, image management, resource monitoring |
| Session Manager | `src/services/session-manager.ts` | Session state, token generation, config management |
| WebSocket Server | `src/services/websocket-server.ts` | Client connections, auth, VNC relay |
| Dependency Checker | `src/services/dependency-checker.ts` | Docker/Tailscale/WSL detection |
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

## Connection Flow

```
1. Host starts → Docker container created → KasmVNC starts on port 6901 (inside container)
2. Docker maps container:6901 → localhost:6901 (host only)
3. Host generates session token → encodes into invitation code
4. Host starts WebSocket server on port 9500

5. Client receives invitation code → decodes → connects WebSocket to host:9500
6. Client sends AUTH_REQUEST with token
7. Host verifies token → prompts host user for approval
8. Host user approves → APPROVAL_GRANTED sent to client

9. Host opens TCP connection to localhost:6901 (KasmVNC)
10. Binary VNC data relayed: Client ↔ WebSocket ↔ Host ↔ TCP ↔ Container VNC
```

## Data Flow for Input

```
Client mouse click on canvas
    → Captured as VNC pointer event
    → Sent as binary WebSocket message to host
    → Host relays to container's KasmVNC TCP socket
    → KasmVNC processes click inside container's virtual X11
    → Chromium browser receives click event
    → Container screen updates
    → VNC framebuffer update sent back through relay
    → Client canvas renders updated frame
```

**Critical point**: At NO stage does any input event touch the host's Windows desktop, mouse driver, or keyboard driver.

## Profile preparation and lifetime

`ChromeProfiles` catalogs the host Windows user's Chrome profiles and, after native host approval, builds a portable bookmark/preferences snapshot. `profileArchive` creates an in-memory archive with fixed paths for Docker's default user template before container startup. Password/cookie databases and encryption keys are excluded.

`SessionManager` gates invitations behind private setup for imported profiles. `WebSocketServer.openHostSetup` creates an authenticated loopback-only HTTP/WebSocket proxy into the same workspace; its token is separate from all client tokens. The main process opens a sandboxed viewer without a preload or Node integration, in an ephemeral partition. The host signs in and confirms readiness; the private viewer is revoked and closed before invitations are enabled. Client connection still requires explicit host approval.

Imported-profile data lives only in the owned temporary container. Client disconnect ends this session and normal stop removes the container plus anonymous volumes. A detached `cleanup-worker` is started and checked before import and watches the parent IPC channel, removing its exact container if the host crashes. It retries if Docker is temporarily unreachable. Fresh-browser sessions retain the original reconnect workflow until the host stops them.

The client main process assigns each approved connection a random in-memory Electron partition and validates it when the renderer attaches the guest. Disconnect destroys that guest, clears its partition data/cache and displays a blank inactive viewer. Subsequent connections use a fresh partition; cleanup does not block reconnect or run against the new partition.

## Technology Choices

| Choice | Technology | Rationale |
|--------|-----------|-----------|
| Container | Docker + kasmweb/chrome | Battle-tested isolation, maintained image, built-in VNC |
| VPN | Tailscale | Zero-config WireGuard, no port forwarding needed |
| Desktop Framework | Electron | Cross-platform, native installers, embedded web views |
| Language | TypeScript | Type safety, refactoring support, modern JS features |
| VNC Protocol | Raw TCP relay | Simplest, most reliable approach for MVP |
| UI | Vanilla HTML/CSS/JS | No build complexity for renderer, fast iteration |
| Installer | electron-builder + NSIS | Industry standard for Electron Windows installers |
