// Diagnostic wrapper for the real-container smoke test, not packaged.
const { app } = require('electron');
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('console-message', (_event, level, message) => { if (/WebSocket|Failed when|Uncaught/.test(message)) console.log(`Guest console ${level}: ${message}`); });
  contents.on('did-fail-load', (_event, code, description) => console.log(`Guest load failed: ${code} ${description}`));
  contents.session.webRequest.onCompleted({ urls: ['http://*/*'] }, details => { if (details.statusCode >= 400) console.log('Guest HTTP:', details.statusCode, new URL(details.url).pathname); });
  contents.session.webRequest.onErrorOccurred({ urls: ['http://*/*', 'ws://*/*'] }, details => console.log('Guest network error:', details.error, new URL(details.url).pathname));
  contents.on('did-finish-load', async () => {
    console.log('Guest document:', await contents.executeJavaScript('JSON.stringify({path:location.pathname,state:document.documentElement.className})'));
    const url = new URL(contents.getURL());
    if (url.protocol !== 'http:') return;
    const cookies = await contents.session.cookies.get({ name: 'pb_stream' });
    const http = require('http');
    http.get(url.origin + '/', { headers: { Cookie: cookies.map(c => c.name + '=' + c.value).join(';') } }, response => {
      let body = ''; response.on('data', chunk => body += chunk); response.on('end', () => console.log('Root response:', response.statusCode, response.headers['content-type'], body.length));
    }).on('error', () => {});
  });
});
require('../client-app/dist/main/index');
