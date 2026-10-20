const { app } = require('electron');
const path = require('node:path');
app.setPath('userData', path.resolve(__dirname, '../.git/qa-recovery/client'));
require('../client-app/dist/main/index');
