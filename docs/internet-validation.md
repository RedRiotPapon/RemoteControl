# Internet sharing validation — 11 October 2026

Version: 1.1.0, Windows x64. Docker/Kasm Chrome retained. No Tailscale connection was used by these tests.

## Completed checks

| Check | Result |
| --- | --- |
| TypeScript builds for shared, Host and Client | Pass |
| Regression suite | 34 passed, 0 failed |
| Bundled cloudflared pin | Official 2026.10.0 binary; SHA-256 verified at build and runtime |
| Helper integrity failure | Missing/modified helper rejected before execution |
| Secure invitations | PB2 marker required; stripped marker cannot downgrade to LAN |
| Approved viewer address | Client rejects an origin different from its invitation |
| Public endpoint before approval | Browser and file routes return 403 |
| Native portable EXE | Launch, public WSS invitation, manual approval, HTTPS viewer, disconnect, invalid-code recovery passed against mock workspace |
| Rebuilt Host UI | 700 × 550 launch; Start/Generate controls visible with explanatory idle state |
| Rebuilt apps with real Docker browser | Public invitation, approval and KasmVNC display passed |
| Client file toolbar | Binary/Unicode uploads, duplicate preservation, empty file and native save dialog passed |
| Large internet upload | 105 MiB in ordered 4 MiB requests; remote size and SHA-256 matched |
| Website upload | Client file selected through the remote Chrome picker and submitted to a synthetic website; SHA-256 matched |
| Website download | Browser response saved to client PC with identical bytes |
| File restrictions | Traversal/symlink download denied; folders/incomplete files omitted; disconnect revoked file access |
| Cancelled chunk upload | Cancellation stops further parts and requests cleanup |
| Temporary Chrome profile | Synthetic profile permission cancel/accept, private host-only sign-in, setup gating and client use passed |
| Profile disconnect | Exact container removed, old client partition cookie cleared, synthetic source unchanged |
| Forced Host termination | Exact profile container removed and both owned tunnel worker/helper PIDs exited |

The real integration tests launched both apps on this Windows PC and sent control, display and files through a public Cloudflare endpoint with normal TLS certificate validation. They did not use a second physical client PC or a second ISP. Website/account fixtures were synthetic; no real sign-in credentials or host profile contents were imported.

The tunnel process used approximately 37–45 MiB working set in observed runs, in addition to the Electron Host/worker and Docker browser. This is a sample rather than a memory ceiling or a full workload benchmark. Uploads do not buffer the whole file: the Client streams bounded blocks and the Host buffers at most one 4 MiB part per receiving request, with four simultaneous body readers allowed.

## Reproduce

Install development dependencies, run `npm run bundle:tunnel`, `npm run build:all`, and `npm test`. Build release apps with `npm run dist:all`.

With `PLAYWRIGHT_MODULE` pointing to an installed Playwright package:

```powershell
$env:PB_QA_INTERNET = '1'
node scripts/ui-smoke.js
node scripts/ui-portable-smoke.js

$env:PB_QA_PACKAGED = '1'
$env:PB_QA_LARGE = '1'
node scripts/ui-file-smoke.js
node scripts/ui-profile-smoke.js
```

The portable test uses the actual self-extracting EXE with a mock Host workspace. File/profile tests use real Docker workspaces and QA-only dialog stubs. They close their own apps and remove their own containers. Test captures that might contain local profile names or invitation codes remain ignored by Git.

Locally the Host was packaged with `npmRebuild=false` because the existing optional native addon was locked by an already-running process. The release workflow performs the standard native rebuild on a clean Windows runner. Tests above exercised the local packaged executable. Service availability limits and relay trust are documented in [internet sharing](internet-sharing.md).
