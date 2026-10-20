# Recovery and resource validation — 20 October 2026

Version 1.1.1, Windows x64. Docker/Kasm Chrome and the bundled Cloudflare helper are retained. No real user profile or signed-in account is used by these tests.

## Automated checks

`npm run build:all` passes. `npm test` passes **42 tests**, including:

- Three repeated control drops restore the same approved session and credential without another approval.
- Browser access returns 403 during recovery. Invalid resume credentials, reused invitations, active-client replacement and expired recovery windows are rejected.
- Explicit leave during recovery removes an imported-profile workspace. Host disconnect prevents recovery. Heartbeat failure enters bounded recovery; expiry clears credentials and profile state.
- Display proxy preserves fragmented binary frames and upstream Origin/authentication, rejects foreign origins, and revokes open connections on stop.
- Quality bootstrap accepts only fixed presets, including the actual frame-rate limits.
- CPU/RAM values reach Docker container limits with isolation unchanged. Excessive allocation fails before creating a workspace.
- Existing native-file, profile-consent, token-expiry, cleanup-retry and input-proxy regressions pass.

## Electron and actual browser checks

`scripts/ui-recovery-smoke.js` uses separate QA app-data directories, a fresh synthetic workspace and explicitly scoped fault injection. `PB_QA_REAL=1 PB_QA_INTERNET=1` exercises the actual Docker browser over public HTTPS/WSS. It checks:

- Saved CPU/RAM settings and actual 4-core/4-GiB container ceilings.
- Client controls visible at the minimum 800×600 window size.
- Low data (18 FPS), Balanced (24 FPS) and Sharper (30 FPS) settings inside the actual Kasm viewer.
- Automatic display reconnection, three control reconnections and preservation of the session ID and ephemeral viewer partition.
- Refresh view preserves an opened remote-browser page.
- 70 seconds idle with ping/pong on both display hops; Host Stop clears the viewer and revokes the recovered session.

The mock-workspace variant checks the same client recovery UI without Docker. The portable EXE launch/approval/viewer/disconnect smoke check is separate.

## Practical limits

Public traffic traverses Cloudflare, but both test apps run on the same Windows PC; this is not a second physical PC/ISP field test. Frame-rate settings and successful recovery are verified; no before/after latency benchmark or guarantee that additional CPU solves network slowness is claimed. File transfers interrupted during recovery must be restarted. The existing user workspace is not stopped or replaced by these tests.

The independent 1.1.0 large-file/website-picker/download and forced-host-cleanup results remain recorded in [internet-validation.md](internet-validation.md); they are historical evidence, not a claim that every old integration test was repeated for this patch.
