// Convenience wrapper around dev-server.js for local development: starts the
// server and opens it in your default browser once it's actually responding.
// dev-server.js itself stays plain (no auto-open) since it's also used
// headlessly (CI, automated browser testing) where popping open a browser
// would be unwanted or fail outright.
//   node dev.js
const { spawn, exec } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 8080;
const URL = `http://localhost:${PORT}`;

const server = spawn(process.execPath, [path.join(__dirname, 'dev-server.js')], {
  stdio: 'inherit',
  env: process.env,
});
server.on('error', (err) => { console.error('Could not start dev-server.js:', err.message); process.exit(1); });

function openBrowser() {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
  exec(`${cmd} ${URL}`, (err) => {
    if (err) console.log(`Could not auto-open a browser — open ${URL} manually.`);
  });
}

// Poll briefly until the server actually accepts connections before opening
// the browser, rather than racing a fixed delay against server startup.
function waitThenOpen(retriesLeft = 30) {
  http.get(URL, (res) => { res.resume(); openBrowser(); })
    .on('error', () => {
      if (retriesLeft > 0) setTimeout(() => waitThenOpen(retriesLeft - 1), 150);
      else console.log(`Server didn't respond in time — open ${URL} manually.`);
    });
}
waitThenOpen();

process.on('SIGINT', () => { server.kill(); process.exit(0); });
process.on('SIGTERM', () => { server.kill(); process.exit(0); });
