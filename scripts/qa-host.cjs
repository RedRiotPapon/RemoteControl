// Electron-only test harness. Never included in the installers.
const { DependencyChecker } = require('../host-app/dist/services/dependency-checker');
const { DockerService } = require('../host-app/dist/services/docker-service');
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const { SessionManager } = require('../host-app/dist/services/session-manager');
// Bind a free port so UI checks can run alongside a host the user is working in.
let qaPort;
const start = WebSocketServer.prototype.start;
WebSocketServer.prototype.start = async function () {
  if (!this.httpServer) this.port = 0;
  await start.call(this);
  qaPort = this.port = this.httpServer.address().port;
};
const invitation = SessionManager.prototype.generateInvitation;
SessionManager.prototype.generateInvitation = async function (...args) {
  const code = JSON.parse(Buffer.from(await invitation.apply(this, args), 'base64url').toString());
  code.p = qaPort;
  return Buffer.from(JSON.stringify(code)).toString('base64url');
};
// Keep mock QA independent of an unresponsive local Docker named pipe.
DockerService.prototype.isAvailable = async () => false;
DependencyChecker.prototype.checkAll = async () => ({
  docker: { installed: true, running: true, version: 'QA mock' },
  tailscale: { installed: false, connected: false, ip: null },
  wsl: { installed: true, version: '2' },
});
require('../host-app/dist/main/index');
