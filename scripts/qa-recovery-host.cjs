// QA only: capture this process's server to inject scoped connection failures.
const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.resolve(__dirname, '../.git/qa-recovery/host'));
const { WebSocketServer } = require('../host-app/dist/services/websocket-server');
const start = WebSocketServer.prototype.start;
WebSocketServer.prototype.start = async function (...args) {
  this.port = 0; await start.apply(this, args); global.__pbQaServer = this;
  this.on('server-error', message => console.error('QA display proxy:', message));
};
if (process.env.PB_TEST_MODE === '1') require('./qa-host.cjs');
else require('../host-app/dist/main/index');
