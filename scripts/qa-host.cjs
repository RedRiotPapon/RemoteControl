// Electron-only test harness. Never included in the installers.
const { DependencyChecker } = require('../host-app/dist/services/dependency-checker');
DependencyChecker.prototype.checkAll = async () => ({
  docker: { installed: true, running: true, version: 'QA mock' },
  tailscale: { installed: false, connected: false, ip: null },
  wsl: { installed: true, version: '2' },
});
require('../host-app/dist/main/index');
