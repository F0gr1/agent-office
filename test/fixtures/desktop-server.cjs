const http = require('node:http');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      capabilities: { automaticDispatch: true },
      runs: process.env.DESKTOP_TEST_BUSY === '1' ? [{ status: 'running' }] : [],
      activeRunId: process.env.DESKTOP_TEST_BUSY === '1' ? 'test' : null,
    }),
  );
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
