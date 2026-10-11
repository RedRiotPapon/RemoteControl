# Usability and capability review — 11 October 2026

The apps support an isolated browser with independent input, client file transfer, and host-approved session-only import of Windows Chrome bookmarks/basic settings. The host signs in privately before approving a client. They do **not yet run installed Windows programs or share an exact existing signed-in Windows Chrome process**. The Windows workspace described below remains a proposed next implementation.

## Findings and repairs

Version 1.1.0 adds bundled internet sharing without a VPN installation. Host approval, profile setup and client files work through public HTTPS/WSS. See [current validation](internet-validation.md) and [relay limits/privacy](internet-sharing.md). The earlier evidence below describes the browser/profile repairs that this release preserves.

| Finding | Result |
| --- | --- |
| Host displayed Running even when startup returned `success: false` | Fixed: backend state drives the dashboard; failures appear inline |
| Width, height and duration used the wrong IPC property names | Fixed and validated; duration 0 remains unlimited |
| Settings could describe a resolution that the running container did not use | Settings are locked during an active session |
| Container startup and connection server startup could leave a partial session | Server startup failure rolls back the browser session |
| First image download had no visible progress | Progress is displayed on the session card |
| Both peers echoed heartbeats | Removed the echo loop |
| Stream became available to anyone once a client was approved | Every stream HTTP request and upgrade now needs an approved stream credential |
| Control and browser upgrades had competing handlers | Exactly one upgrade handler routes control separately from KasmVNC |
| Proxy omitted Kasm Basic authentication and broke absolute resource paths | Host supplies backend credentials; authenticated resources are served at the origin root |
| Pinned KasmVNC rejected lowercase authentication/upgrade headers | Canonical header names are preserved; real HTTP and RFB upgrade checks pass |
| Disconnect did not close existing browser transport sockets | Open proxy sockets and requests are destroyed on disconnect or session stop |
| Invitations were not expired on the host or consumed after approval | Host enforces expiry, rechecks approval and consumes the invitation |
| Placeholder VNC canvas could not decode frames | Removed; client uses the workspace's actual KasmVNC web viewer |
| Reconnect reused a consumed invitation; rejection was overwritten on close | Reconnect returns to invitation entry; terminal reasons are preserved |
| Approval stole host focus | Host taskbar flashes without forcing foreground focus |
| Quit did not await container cleanup | App waits for its cleanup before exiting |
| Stopping one instance removed containers owned by other instances | Cleanup is restricted to the instance's own container |

The UI now includes copy feedback, actionable errors, keyboard focus, a settings focus trap, reduced-motion support, scrollable small windows, and clear disclosure of temporary data and current workspace limits.

## Validation

- `npm run build:all`: TypeScript and renderer builds pass.
- `npm run dist:all`: both Windows installers rebuilt; the client was rebuilt again after the final viewer cleanup repair. Both packaged executables opened their UI with working preload APIs and passed the full real file-transfer and profile tests with `PB_QA_PACKAGED=1`. Updated copies are in `installer/`, with SHA-256 hashes matching the release outputs. Installation through the setup wizard was not tested.
- `npm test`: 31 tests pass, including authenticated HTTP and WebSocket proxying, foreign-origin rejection, stream revocation, invitation consumption/expiry, cancellation, rejection, startup rollback, cleanup retry, binary/Unicode file transfer and interrupted/cancelled local saves. Profile-specific checks cover catalog validation, credential/history exclusion, unsafe bookmark URL exclusion, private-viewer separation, invitation gating, heartbeat expiry and automatic disconnect cleanup.
- `scripts/ui-smoke.js`: Electron windows pass setup, settings, invitation, approval, embedded viewer load, host stop, invalid-code recovery and minimum-window-size checks. Both a mock backend and **real Docker/Kasm Chromium** were exercised. Screenshots are in `docs/qa/`.
- Real input validation sent keyboard events through the guest viewer, navigated Chromium to a local test page, and sent a mouse click through that viewer to a page button. The browser's actual window title was checked inside the container after each step. The framebuffer screenshot shows the resulting page. Native Electron capture is used to include the embedded viewer compositor.
- `scripts/qa-backend.js`: real HTTPS Kasm authentication, protected HTTP proxy and RFB WebSocket greeting pass.
- The browser container, including the file service, used about **566 MB** in the latest light browser test. Its configured memory limit is 2 GiB with a 2-core CPU limit. This excludes Electron, Docker/WSL overhead and the host's existing workloads; heavy sites may use considerably more.
- Docker Desktop startup was repaired by preserving and recreating inaccessible runtime socket directories; the Linux engine now responds. See [recovery details](docker-recovery.md). The pinned browser image was downloaded for testing. All test containers were stopped and removed; the existing OCR container was left running.
- `scripts/ui-file-smoke.js`: real client upload to the workspace, duplicate-name handling, Unicode/binary integrity, website submission through Chromium's remote file picker, browser download, and saving identical bytes to the client PC pass. Native Windows file dialogs are stubbed only in the QA process; transfer IPC and streams are real. The test website runs inside the test container. Minimum-size downloads UI and disconnect revocation pass. Separate regression checks preserve an existing destination and remove temporary files after interruption/cancellation.
- The real workspace file agent also passed traversal/symlink rejection, exclusion of directories and incomplete downloads, and empty-file upload checks.
- Independent host/client input follows from the container's separate display. Automated input was delivered only to the client guest viewer and container. Two-person simultaneous use, internet latency, audio, clipboard and extended browsing were not measured. File tests used 128 KiB real fixtures and a 512 KiB regression fixture; the 1 GiB upload boundary was checked by request validation rather than transferring a 1 GiB fixture.

## Client file workflow

Clients use **Upload from this PC**, then choose the copied file from **Uploads** in the website's remote file picker. Uploads are limited to 1 GiB each and repeated names receive numbered suffixes. For browser downloads, clients open **Downloads**, refresh if needed, and choose **Save to this PC** to pick a local destination. The app displays progress, supports cancellation, and returns focus to the browser after the transfer. Files are streamed in bounded chunks; the client needs no Docker/Python installation. Workspace copies are temporary and disappear when the host stops the session. Update both apps to use this feature.

## Windows application and profile requirement

### Implemented portable Chrome profile flow

The host selects a Windows Chrome profile by name, reviews a native confirmation, and authorizes a copy for this session. Only web bookmarks, homepage, bookmark-bar visibility and the display name are reconstructed in the isolated browser. Cookies, passwords, history, autofill, extensions and Windows keys stay on the host. The source profile is never modified. The host opens **Private setup**, signs in manually, then marks setup finished and confirms it is ready to share. Invitations remain blocked until then, and client access still needs a separate host approval.

Private setup is authenticated and bound only to loopback, separate from the public client listener. It closes and revokes its credential before client invitation. Imported-profile sessions remove the owned workspace on client disconnect, host stop/quit or duration expiry. A detached helper handles abrupt host termination and retries removal if Docker is temporarily unavailable. Every approved client connection gets a new in-memory viewer partition; disconnect destroys that viewer and clears its storage/cache without blocking reconnect. Explicitly saved client files remain. Data lives in the host's Docker workspace, not a permanent profile on the client PC; cleanup is container removal, not forensic secure erasure.

`scripts/ui-profile-smoke.js` passed against both source and packaged apps. It exercised native approval cancel/accept with QA-only stubs, imported synthetic bookmarks/preferences, a host-only test website sign-in through the viewer, blocked invitations before setup, client approval, minimum-size host UI, disconnect container removal, and forced-host-termination removal. The final packaged run also verified destruction of the client viewer and removal of its old stream cookie. No real host profile contents or real account credentials were copied. Screenshots are in `docs/qa/host-private-setup.png` and `docs/qa/host-profile-small.png`.

### Remaining Windows program support

The requested apps and profiles are the ones currently on the host Windows PC. A container cannot run those Windows processes. Sharing the existing interactive desktop with global input injection would make the users interfere with each other.

For this machine, use one reusable local Hyper-V Windows VM with dynamic memory. Windows 11 Pro and about 32 GiB physical RAM were detected, with an active hypervisor. The current session cannot list or manage VMs: `Get-VM` returned a permission-denied error. Existing VM availability is therefore unknown. No guest installation image was found in this repository.

Suggested starting budget, subject to workload measurement: 2 virtual CPUs, 4 GiB startup/minimum RAM, and an 8 GiB maximum. Run the VM only while a Windows workspace is needed; shut it down or save it when the host ends the workspace. These are design estimates, not measured performance guarantees. Dynamic memory allows the host to reclaim unused guest memory, but it does not remove the guest OS overhead.

The client should keep the existing invitation/approval/viewer workflow. All VM management and credentials belong on the host. The next backend must provide:

1. Host-only VM selection, readiness checks, startup, dynamic-memory configuration and explicit shutdown/save handling.
2. A display/input transport into the **guest** session, integrated with the authenticated stream proxy and a compatible client viewer. The existing Docker/Kasm proxy is not a Windows VM transport.
3. An app/profile catalog collected inside the guest, with a host picker that launches the selected guest app/profile. Never execute client-supplied program paths or inject input into the host desktop.
4. One-time installation or migration of the required Windows apps and permitted browser data into the guest. Existing running host app instances remain on the host. Do not promise that passwords, cookies, extensions or signed-in sessions survive migration; browser/account-specific sign-in may be required.
5. End-to-end validation with two users: simultaneous typing/clicking, no host focus theft, guest app/profile launch, reconnect, interruption handling, resource use and data persistence.

If selecting the exact currently running host application/profile is mandatory, that requirement still needs a different, validated isolation solution. A VM provides a separate copy/environment rather than sharing that same running process.

Microsoft references: [Hyper-V requirements](https://learn.microsoft.com/virtualization/hyper-v-on-windows/reference/hyper-v-requirements), [Hyper-V memory performance](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/hyper-v-server/memory-performance), [Windows multi-session limitations](https://learn.microsoft.com/en-us/azure/virtual-desktop/windows-multisession-faq). Kasm references: [profile storage](https://docs.kasm.com/docs/latest/how-to/data-storage/persistent-profiles) and [custom images](https://docs.kasm.com/docs/develop/how-to/workspaces-sessions/container-workspace/customization/building-images).

## Remaining release limits

- This release shares a temporary Linux browser, with portable Windows Chrome bookmark/settings import and fresh manual sign-in. Installed Windows apps, full-profile migration and Windows VM provisioning are not implemented.
- LAN traffic is HTTP/WebSocket without TLS. Use Internet mode for HTTPS/WSS through the bundled Cloudflare tunnel; see [relay trust and availability limits](internet-sharing.md). Do not expose port 9500 directly to the internet.
- The existing Electron 28 runtime should be upgraded and retested before broad distribution. No runtime upgrade was bundled into this functional repair.
- Docker bridge networking is not an egress firewall: the container may reach LAN/gateway services. Display/input isolation does not imply network isolation.
