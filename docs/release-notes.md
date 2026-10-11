# ParallelBrowser 1.1.0

Host and Client now connect across different networks with **no Tailscale installation, VPN account or port forwarding**. The Host bundles its internet helper, checks connectivity and shows when sharing is ready. Docker Desktop remains required on the Host. Update **both apps** and generate a new invitation.

## Downloads

- **ParallelBrowser-Client-Portable.exe** — recommended: download, double-click, enter a name, paste the invitation and Connect. No installation wizard, Docker, Node.js or Python on the client PC.
- **ParallelBrowser-Client-Setup.exe** — optional one-click per-user installation, opens when finished.
- **ParallelBrowser-Host-Setup.exe** — install on the PC providing the Docker browser.
- **SHA256SUMS.txt** — SHA-256 checksums for all three EXEs.

Windows x64. These builds are unsigned, so Windows may show a publisher/reputation warning. The portable Client extracts its bundled runtime before opening and may take a moment on first launch.

## Connect

1. Host: leave **Connect through → Internet** selected, choose a browser/profile and click **Start Browser**.
2. Finish any required private profile setup. Wait for **Internet sharing is ready**.
3. Click **Generate Invitation → Copy invitation** and send the complete `PB2-` code to your client.
4. Client: paste the code and click **Connect**. Host: review the request and click **Approve**.

The invitation is a code for the Client app, not a clickable join link. It expires in 60 minutes and works for one approved connection. Start a new browser session and generate a new code if internet sharing stops. A **Local network** option remains for trusted LAN use.

Client uploads use small sequential requests over HTTPS, preserving the 1 GiB per-file limit. Use **Upload from this PC**, then select the file from **Uploads** in the remote website's file picker. For browser downloads, open **Downloads → Save to this PC**.

## Service and profile limits

Internet sharing uses a bundled **Cloudflare Quick Tunnel**, a best-effort preview service without an uptime SLA. Cloudflare terminates TLS; traffic is encrypted in transit but is not end-to-end encrypted between the PCs. See [service limits, privacy and troubleshooting](https://github.com/RedRiotPapon/RemoteControl/blob/main/docs/internet-sharing.md).

Profile import still requires host permission and copies only bookmarks/basic settings. The host signs in manually in private setup before separately approving the client. Existing Windows passwords and sign-in cookies are not copied. Imported-profile sessions are removed when the active client disconnects; the original host profile stays unchanged. Files explicitly saved to the client's PC remain there.

This release shares an isolated Linux browser with independent input. Installed Windows programs and the original running Windows Chrome window are not shared.

## Validation

All 34 regression checks pass. Rebuilt Windows apps passed public HTTPS/WSS browser and file-transfer checks, including a 105 MiB upload with SHA-256 verification, remote website file selection and a browser download saved back to the client PC. Packaged profile tests verified manual host setup, approval gating, disconnect cleanup and container/tunnel cleanup after forced Host termination. The actual portable EXE passed public invitation/approval/viewer/disconnect checks against a mock workspace. See [validation details](https://github.com/RedRiotPapon/RemoteControl/blob/main/docs/internet-validation.md).
