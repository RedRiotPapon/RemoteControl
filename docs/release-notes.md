# ParallelBrowser 1.0.0

## Which file to download

- **ParallelBrowser-Client-Portable.exe** — recommended for clients. Download and double-click; no installation wizard, Docker, Node.js, Python or administrator access is required by the app.
- **ParallelBrowser-Client-Setup.exe** — optional one-click installation for clients who want an installed app. The app opens when installation finishes.
- **ParallelBrowser-Host-Setup.exe** — install on the PC providing the browser. Docker Desktop with its Linux engine must be available on that PC.
- **SHA256SUMS.txt** — checksums of the three EXE files.

Windows x64 builds. The binaries are currently unsigned, so Windows may show an unknown-publisher or reputation warning. The portable EXE extracts its bundled app into a temporary directory before opening; the first launch may take a moment.

## Client: open, paste, connect

1. Open **ParallelBrowser-Client-Portable.exe**.
2. Enter your name and paste the invitation code sent by your host.
3. Click **Connect** and wait for the host to approve.

On the same local network, no VPN is required. For PCs on different networks, the host must help set up Tailscale on both PCs first. The app does not provide its own internet relay or bypass network/firewall restrictions.

Use **Upload from this PC** to copy a local file to the browser's **Uploads** folder, then select it in the website's file picker. To keep a browser download, open **Downloads** and choose **Save to this PC**.

## Host approval and temporary profiles

The host can choose an existing Windows Chrome profile and approve a temporary copy of bookmarks/basic settings. The host signs into required accounts manually in private setup, finishes setup, then separately approves the client connection. Existing host passwords and cookies are not automatically copied. Disconnecting the active client ends an imported-profile session and removes its temporary workspace. The original host profile stays unchanged. Files the client explicitly saved to their PC remain there.

Installed Windows applications and the original running host Chrome window are not shared. This release provides an isolated Linux browser with independent input.

## Validation

Source build and 31 regression tests pass. The packaged Host and Client passed real profile, private host sign-in, file-transfer, disconnect and forced-host-termination checks. The actual portable EXE also passed launch, invitation, host approval, viewer, disconnect and invalid-code recovery against a mock host workspace. GitHub Release builds are produced by the Windows release workflow.
