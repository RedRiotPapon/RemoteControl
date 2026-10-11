# Docker Desktop runtime socket recovery — 11 October 2026

Docker Desktop 4.83.0 failed before the Linux engine started. Its error named `Docker/run/dockerInference` and Windows error 1920: the file could not be accessed. After recovering that runtime folder, startup encountered the same error on `docker-secrets-engine/engine.sock`.

## Recovery performed

1. Confirmed Docker Desktop was stopped with `docker desktop stop --timeout 15` and checked for remaining Docker Desktop/backend processes.
2. Terminated only the `docker-desktop` WSL distribution.
3. Verified the exact absolute runtime-directory paths, then renamed them in place as recoverable backups. No recursive deletion was used.
4. Restarted the installed Docker Desktop executable.
5. Verified `docker desktop status` reported running and `docker info --format '{{.OSType}}'` returned `linux`. The previously configured OCR container was running and was left untouched.

Preserved folders on the affected PC (replace `%LOCALAPPDATA%` with that Windows user's local application-data directory):

- `%LOCALAPPDATA%\Docker\run-recovery-20261011-121702`
- `%LOCALAPPDATA%\Docker\run-recovery-20261011-121745`
- `%LOCALAPPDATA%\docker-secrets-engine-recovery-20261011-121745`

These are runtime socket backups, not backups of Docker workload data. Docker settings, images, containers, volumes and virtual disks were not reset or deleted. Existing saved containers may start according to their own restart policies when Docker starts.

The workaround matches reports in [Docker's issue tracker](https://github.com/docker/desktop-feedback/issues/625). This was a successful local recovery, not proof that the underlying Docker/Windows socket lifecycle problem is permanently fixed. Reports also describe the inference socket being created even with Model Runner disabled, so disabling that feature alone was not used as the fix.

If the error recurs, fully stop Docker first and inspect the exact endpoint named in the error. Do not rename arbitrary Docker data directories or run Factory Reset/Purge as part of this workaround. Docker's [troubleshooting guide](https://docs.docker.com/desktop/troubleshoot-and-support/troubleshoot/) describes local diagnostics and support options. No diagnostic report was uploaded and no external issue was submitted during this session.
