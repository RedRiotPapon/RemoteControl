# Internet sharing in 1.1.1

Both apps now connect across different networks without Tailscale, VPN setup, port forwarding, a tunnel account or a separate networking installation. Docker Desktop remains required on the Host. The Client only needs its EXE.

## Use it

1. Update **both** Host and Client to 1.1.1 or later.
2. Open Host, complete the Docker check and leave **Connect through → Internet** selected.
3. Choose a fresh browser or a Chrome profile and click **Start Browser**. The Host starts its bundled tunnel automatically, then checks its public HTTPS endpoint before enabling invitations. First browser startup can take several minutes; internet connection setup can take another 90 seconds.
4. For a profile, authorize the temporary bookmark/settings copy, sign in yourself in **Private setup**, and confirm **I've finished setup**.
5. Click **Generate Invitation → Copy invitation** and send the complete code to your client. Internet codes begin with `PB2-`; these are codes for the app, not clickable browser links.
6. The Client opens its EXE, enters a name, pastes the code and clicks **Connect**. The Host sees the request and must click **Approve**.
7. Stop the browser when finished. Starting a new session produces a new internet address and needs a new invitation. Old codes do not reconnect to another session.

The Client can upload files from its own PC and save remote browser downloads to its own PC. Uploads are limited to 1 GiB per file and use sequential requests of at most 4 MiB over the internet. Memory use does not grow with the whole file size. Abandoned chunk uploads expire after five minutes of inactivity, checked every minute, or disappear when the workspace is removed. Cancellation attempts immediate cleanup. Completed uploads preserve existing filenames by adding a number.

## Service and privacy

The Host includes the unmodified Windows x64 **cloudflared 2026.10.0** binary. It creates a temporary **Cloudflare Quick Tunnel** using outbound HTTP/2; the Client uses normal certificate-validated HTTPS and WSS. The Host listener and Docker services bind only to loopback in Internet mode. No inbound router port needs opening. Restrictive networks may still block the required outbound connections (including Cloudflare tunnel traffic on TCP 7844).

Quick Tunnels are a best-effort preview service for testing/development, with no uptime SLA and a limit of 200 in-flight requests. They do not support Server-Sent Events. Brief display/control interruptions now reconnect automatically. Control recovery lasts up to one minute and requires the same approved client's separate in-memory credential. If recovery expires, request a new invitation; imported-profile workspaces are cleaned up. If the tunnel helper itself exits or the public hostname stops working, stop/restart the browser and issue a new invitation. This release does not promise production relay availability. See [Cloudflare Quick Tunnel limits](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) and [tunnel firewall requirements](https://developers.cloudflare.com/tunnel/configuration/).

TLS encrypts traffic to/from Cloudflare, which terminates HTTPS and can process the browser stream and transferred file contents. This is **not end-to-end encryption** between the two PCs. Keep invitation codes private. The public hostname alone grants no browser/file access: token validation and manual Host approval are still required. Private host setup is on a separate loopback-only listener and is never routed through the tunnel. Once approved, client use of the signed-in browser goes through the relay.

## Offline/local choice and troubleshooting

**Local network** is available for two PCs on the same trusted LAN. It binds port 9500 to local interfaces and uses unencrypted HTTP/WebSocket; allow only intended LAN peers through the firewall and never forward that port to the internet. It does not start the tunnel.

If internet sharing fails, check internet access, antivirus/firewall handling of the bundled helper and the status shown under **Connect through**. Reinstall the latest Host if helper verification fails. No download or installation of cloudflared is needed at runtime. Do not reset Docker to troubleshoot a network tunnel error. Use [Docker recovery](docker-recovery.md) for the separate Docker runtime-socket error.

If no approval arrives, confirm both apps are updated and the host generated a new `PB2-` code after **Internet sharing is ready**. A legacy LAN code cannot connect two unrelated networks. If the Client says it is waiting for approval, check the Host's **Client Connection** card; a minimized Host is restored and flashes when a request arrives.

## Slowness or a frozen display

Update **both** apps to 1.1.1. Start with **Display → Balanced**; choose **Low data** if scrolling/video struggles or the connection is slow. It reduces frame rate and image quality to use less bandwidth. **Sharper** favors clearer moving images and uses more data. **Refresh view** reconnects the display only, preserving remote browser tabs and website state. Interrupted file transfers must be started again after reconnection.

Display WebSockets now use ping/pong to avoid inactivity closures, and temporary failures retry automatically instead of requiring repeated manual reloads. A reconnecting Host badge means the session is held for the same approved client, not waiting for another approval. The Host can still disconnect at any time. Relay distance, host upload bandwidth, Docker CPU limits and heavy websites can still affect responsiveness.

## Reproducible helper packaging

`npm run bundle:tunnel` downloads the pinned official binary at build time and verifies SHA-256 before storing it in ignored `host-app/vendor/`. `npm run dist:host` and `dist:all` do this automatically. For source development, run `npm run bundle:tunnel` once before starting Host in Internet mode. The installed Host verifies the packaged helper again before launching it. Automatic helper updates are disabled. Version/hash updates require a reviewed app release.

- [Official release 2026.10.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.0)
- SHA-256: `86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c`
- License: Apache-2.0, included at `resources/third-party/cloudflared-LICENSE.txt`.
- The binary is not committed to Git. A detached worker owns it and closes it on Host quit, stop, startup failure or parent-process loss. It never requires stopping unrelated tunnels or programs.
