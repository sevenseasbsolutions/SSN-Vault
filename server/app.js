import express from 'express';
import { AppError } from './lib/errors.js';
import { attachUser, csrfGuard, rateLimit } from './auth/middleware.js';
import { purgeExpiredSessions } from './auth/session.js';
import { securityHeaders, mountFrontend } from './web.js';

import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import orgRoutes from './routes/org.js';
import jobsRoutes from './routes/jobs.js';
import salariesRoutes from './routes/salaries.js';
import expensesRoutes from './routes/expenses.js';
import taxRoutes from './routes/tax.js';
import dashboardRoutes from './routes/dashboard.js';
import reportsRoutes from './routes/reports.js';
import settingsRoutes, { auditRouter } from './routes/settings.js';
import attachmentsRoutes from './routes/attachments.js';

export function createApp({
  logger = console,
  serveFrontend = process.env.SERVE_FRONTEND !== 'false',
} = {}) {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));
  app.disable('x-powered-by');

  app.use(securityHeaders);

  // Attachments read their own raw body; everything else is JSON.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/attachments') && req.method === 'POST') return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });

  app.use(attachUser);
  app.use(csrfGuard);
  app.use('/api', rateLimit({
    windowMs: 60_000,
    max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
    key: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/users', usersRoutes);
  app.use('/api/org', orgRoutes);
  app.use('/api/jobs', jobsRoutes);
  app.use('/api/salaries', salariesRoutes);
  app.use('/api/expenses', expensesRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportsRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/audit', auditRouter);
  app.use('/api/attachments', attachmentsRoutes);

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } });
  });

  /*
   * The frontend. Served from here for development and the tests; a
   * deployment runs it as its own service (server/frontend.js) behind nginx
   * and sets SERVE_FRONTEND=false so this process answers /api only.
   */
  if (serveFrontend) mountFrontend(app);

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
    }
    /*
     * A value Postgres cannot read as the column's type -- an id of "1.5", a
     * number past BIGINT -- is a bad request, not a server fault. SQLite
     * simply matched nothing; this keeps such requests out of the 500s.
     */
    if (err?.code === '22P02' || err?.code === '22003') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'A value in the request is not valid' } });
    }
    // Unexpected failures are logged in full but never leaked to the client.
    logger.error?.('Unhandled error', { path: req.path, method: req.method, message: err?.message, stack: err?.stack });
    return res.status(500).json({
      error: { code: 'server_error', message: 'Something went wrong. The error has been logged.' },
    });
  });

  return app;
}

export function startHousekeeping() {
  const timer = setInterval(() => {
    purgeExpiredSessions().catch(() => { /* housekeeping is best-effort */ });
  }, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
