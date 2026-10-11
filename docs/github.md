# Repository and release guide

## What belongs in Git

The repository contains the Host and Client source, shared protocol library, package lockfiles, tests, build scripts and documentation. TypeScript in `host-app/src/services` is canonical; old JavaScript generated beside those files is ignored.

Dependencies, compiled `dist` directories, Electron `release` directories and installer executables are generated locally and excluded by `.gitignore`. Browser profiles, credentials, runtime files and unreviewed QA screenshots must not be committed. The two included profile screenshots use a synthetic profile and a local test website.

## Build and verify on Windows

Install Node.js and npm, Docker Desktop with its Linux engine, and WSL 2 on the development host. Docker and WSL are required by the existing local dependency-check tests. Run `npm run bundle:tunnel` before source-mode Internet tests; no VPN is required.

From the repository root:

```powershell
npm run install:all
npm run build:all
npm test
```

The current regression suite has 31 tests. Real browser checks additionally need Docker running and the configured Kasm image. To run Electron UI checks, install Playwright in a separate QA directory or use an existing installation, set `PLAYWRIGHT_MODULE` to its absolute module directory, then run:

```powershell
node scripts/ui-smoke.js
node scripts/ui-profile-smoke.js
node scripts/ui-file-smoke.js
node scripts/ui-portable-smoke.js
```

The first script uses a mock workspace by default; set `PB_QA_REAL=1` to exercise the real browser. The profile and file scripts use real Docker workspaces. The portable script launches the actual self-extracting client EXE after `dist:client` and checks its connection flow against a mock host. Their native-dialog stubs exist only in QA processes and are not included in the app runtime. Generated screenshots remain local unless deliberately reviewed for publication.

## Build Windows installers

```powershell
npm run dist:all
```

Outputs:

- `host-app/release/ParallelBrowser-Host-Setup.exe`
- `client-app/release/ParallelBrowser-Client-Setup.exe`
- `client-app/release/ParallelBrowser-Client-Portable.exe`

Set `PB_QA_PACKAGED=1` before running the profile and file UI checks to exercise the `release/win-unpacked` executables. Installer wizard installation is a separate manual check.

Distribute executables as GitHub Release assets rather than committing them to Git history. Upload both installers together so users have compatible Host and Client file-transfer versions. Publish SHA-256 checksums alongside them, and describe the profile import scope and remaining Windows-program limitation. These binaries use the project's existing Electron 28 runtime; review and upgrade that runtime before broad distribution.

The **Windows downloads** workflow builds all three EXEs on a GitHub-hosted Windows runner and publishes a `v1.1.0` Release with checksums and [release instructions](release-notes.md). Its initial run is triggered when the workflow file is pushed to `main`; it also supports manual dispatch. It creates a draft, uploads all files, then publishes it. An existing release is not overwritten. Update the version/tag and concurrency group deliberately before publishing a later release. GitHub builds do not run the Docker/WSL-dependent local regression suite; run those checks locally before publication.

## Documentation

- [Setup and troubleshooting](setup.md)
- [Current capabilities, validation and limitations](usability-review.md)
- [Architecture](architecture.md)
- [Security and temporary profile cleanup](security.md)
- [Docker runtime socket recovery](docker-recovery.md)

Selecting a host Chrome profile copies only bookmarks and basic settings. The host signs in manually in private setup before approving client access. Existing passwords and cookies are not automatically imported. Installed Windows programs are not supported by this browser backend.
