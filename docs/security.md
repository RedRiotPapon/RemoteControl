# ParallelBrowser Security Documentation

## Security Model

ParallelBrowser implements defense-in-depth security across multiple layers.

## Layer 1: Browser Isolation (Docker Container)

The remote browser runs inside a Docker container (`kasmweb/chrome`), providing:

- **Filesystem isolation**: The container has NO access to host files, user directories, or Windows drives
- **Process isolation**: Browser processes run in a separate namespace, invisible to the host
- **Display isolation**: Browser uses a virtual X11 display inside the container (KasmVNC), never the host's Windows desktop
- **Network access**: Docker bridge networking provides NAT, not an egress firewall. The container can access the internet and may reach LAN, gateway and host-exposed services. Apply network policy separately if needed.

### Container Security Hardening

- `--cap-drop ALL` — Drop all Linux capabilities
- `--cap-add SYS_CHROOT,SETUID,SETGID` — Only minimum required capabilities
- `--security-opt no-new-privileges:true` — Prevent privilege escalation
- `--memory 2g` — Memory limit prevents DoS
- `--cpus 2` — CPU limit prevents resource exhaustion
- No `--privileged` flag
- No host volume mounts
- No access to Docker socket

## Layer 2: Connection Security

### With Tailscale (Recommended)

- All traffic encrypted via WireGuard (Tailscale's protocol)
- No ports exposed to the public internet
- Authentication managed by Tailscale's identity system
- Only Tailscale network members can reach the host

### Without Tailscale (LAN Only)

- WebSocket server binds to all interfaces (0.0.0.0)
- Traffic is NOT encrypted at the transport layer in LAN mode
- Should only be used on trusted local networks
- Not suitable for internet-facing deployment without Tailscale or VPN

## Layer 3: Session Authentication

1. Host generates a cryptographically random session token (256-bit)
2. Token is embedded in an invitation code (base64url-encoded JSON)
3. Invitation codes expire after 60 minutes
4. Client must present valid token before any access is granted
5. Token is verified using HMAC-SHA256 with timing-safe comparison
6. Host can revoke tokens at any time

## Layer 4: Host Approval

Even with a valid token, the host must **explicitly approve** each connection:

1. Client connects and presents token → verified
2. Host sees approval prompt with client name
3. Host clicks **Approve** or **Reject**
4. Only approved clients receive VNC access
5. Host can **Disconnect** at any time

## Layer 5: Input Isolation

Remote input NEVER touches the host's desktop:

- All input events are transmitted via VNC protocol to the Docker container
- VNC operates on the container's virtual display only
- No `SendInput`, `mouse_event`, or keyboard hooks on the host
- No screen capture of the host desktop
- Client receives only the container's framebuffer

## What The Client CANNOT Do

| Action | Blocked By |
|--------|-----------|
| See host desktop | VNC shows only container display |
| Access host files | Docker filesystem isolation |
| Read host clipboard | No clipboard bridge configured |
| Install software on host | No shell access, no volume mounts |
| Access Docker API | Docker socket not exposed to client |
| Scan host network services | Not guaranteed blocked; requires separate egress policy |
| Modify host browser profiles | Separate container filesystem |
| Persist data after session ends | Container removed on stop |

## Known Limitations & Residual Risks

### Medium Risk

1. **Container internet access**: The Chromium browser in the container has full internet access. A user could visit malicious sites, download malware (contained within the container), or use the browser for unauthorized purposes.

2. **Docker escape vulnerabilities**: While extremely rare, container escape vulnerabilities do exist. Keep Docker Desktop updated.

3. **VNC stream interception (LAN mode)**: Without Tailscale, VNC traffic over WebSocket is not encrypted at the transport layer. Use on trusted networks only.

### Low Risk

4. **Resource exhaustion**: While CPU and memory are capped, a container could still generate heavy network traffic.

5. **Container-to-host network scanning**: The container could potentially probe the Docker gateway IP, though default bridge mode limits access to host services.

6. **No rate limiting on auth**: MVP does not implement rate limiting on authentication attempts.

### Mitigations in Future Versions

- Add TLS to WebSocket server (even without Tailscale)
- Implement auth rate limiting and lockout
- Add network policies to restrict container egress
- Add audit logging
- Support multi-factor authentication
- Add container egress firewall rules

## Client file transfer

The client chooses local upload sources and download destinations through native file dialogs. The renderer and remote guest cannot provide arbitrary local file paths to the transfer API. Remote web content receives no preload or file-transfer IPC bridge.

Every approved connection gets a main-process-generated, random, non-persistent viewer partition. The main process validates both its exact partition and origin before attaching the webview. Disconnect replaces the guest element with an inactive blank viewer, revokes file access and clears the old partition's storage/cache asynchronously. Reconnecting uses a new partition and cannot reuse the old stream cookie or web state. Previously listed download filenames are cleared from the client UI. User-saved local downloads are retained.

The host's `/api/files/` routes require the current approved stream bearer credential in an Authorization header; cookies alone are insufficient and browser Origin headers are rejected. No CORS permission is granted. The host forwards only fixed upload/list/download operations to a per-workspace Python service on a separate **loopback-published** Docker port with its own random credential. Disconnect revokes the client credential and closes transfers.

The unprivileged service confines operations to open directory descriptors for `/home/kasm-user/Uploads` and `/home/kasm-user/Downloads`. It rejects path separators/traversal and opens downloads without following symlinks; only regular files are returned. Uploads are limited to 1 GiB each, streamed into hidden temporary files, and published without overwriting existing names. Interrupted upload temporary files are removed. Downloads are streamed into a temporary file beside the client-selected destination and renamed only after successful completion. No host directory or Docker socket is mounted into the workspace. The service is removed with the container.

LAN file transfers use HTTP, matching the existing viewer transport; use the existing Tailscale connection for encrypted remote transport. File bytes are copied into the temporary workspace before a website can use them, and browser downloads require the client to choose **Save to this PC**. Neither direction silently shares a local folder.

## Credential Storage

### Temporary Chrome profile use

The host profile picker reads only Chrome's profile names and IDs from the current Windows user's Local State metadata. Import requires a native host confirmation each session. The snapshot reconstructs only HTTP/HTTPS bookmarks and allowlisted homepage/bookmark-bar preferences in memory; it does not copy Cookies, Login Data, History, extensions, autofill, or Windows encryption keys. Imported paths are fixed and profile directories are checked against Chrome's data root. No host profile folder is mounted into Docker, and the source profile is never written.

The host signs in through a separate viewer served by an authenticated **loopback-only** listener, with its own random credential and an ephemeral Electron storage partition. That credential cannot authorize the public client proxy. Setup revokes any previous invitation. Both invitation verification and issuance remain blocked until the host explicitly confirms setup is finished. Closing private setup alone does not unlock invitations. Completing setup revokes the private viewer before enabling invitations; the host must still approve the client's connection. An approved client can use signed-in accounts and see imported bookmarks, as disclosed by both confirmation dialogs.

Imported-profile sessions end on active client disconnect, host stop/quit, or duration expiry. Stopping revokes streams, closes transfers and removes the exact owned container and its anonymous volumes. A detached cleanup helper, verified ready before data import, removes that same container after abrupt host termination. If Docker is unavailable, the helper retries when the engine returns; cleanup is not instantaneous while Docker cannot be reached. Host control WebSocket ping/pong detects an unresponsive connection after roughly 45–60 seconds and revokes access. Profile snapshots have no disk staging copy. Files the client explicitly saved to their PC and website-side account sessions are outside temporary-workspace cleanup. Container removal does not guarantee forensic secure erasure.

After approval the host consumes the invitation and issues a separate random stream credential. A bootstrap URL sets an HttpOnly, SameSite=Strict cookie and redirects to the origin root. Every HTTP stream request and WebSocket upgrade requires the current cookie; foreign browser WebSocket origins are rejected. The host supplies Kasm backend Basic authentication and does not forward the stream cookie to the container. Disconnect revokes the credential and destroys active proxy sockets/requests. The bootstrap URL is a bearer credential and should not be logged or shared. LAN HTTP still requires a trusted network or VPN.

- Session tokens are generated in-memory and never written to disk
- No credentials are stored in plaintext in source code
- Invitation codes are ephemeral and expire
- The session secret (HMAC key) is generated fresh per host instance

## Recommendations

1. **Always use Tailscale** for internet connections
2. **Keep Docker Desktop updated** for security patches
3. **Stop the browser** when not in use
4. **Monitor resource usage** via the host dashboard
5. **Review the container image** — `kasmweb/chrome` is maintained by Kasm Technologies
