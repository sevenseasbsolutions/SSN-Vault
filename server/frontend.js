/**
 * The frontend service: the single-page app and its static assets, nothing
 * else. It holds no session, touches no database and answers no /api route;
 * nginx sends /api/ to the API service and everything else here.
 */

import express from 'express';
import { securityHeaders, mountFrontend } from './web.js';

const PORT = Number(process.env.WEB_PORT ?? 4011);
const HOST = process.env.WEB_HOST ?? '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use(securityHeaders);
// An /api request reaching this service means the proxy is misrouted. Say so
// plainly rather than answering with the SPA's index.html.
app.use('/api', (req, res) => {
  res.status(502).json({ error: { code: 'misrouted', message: 'API requests are not served here' } });
});
mountFrontend(app);

const server = app.listen(PORT, HOST, () => {
  console.log(`Frontend is running at http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
