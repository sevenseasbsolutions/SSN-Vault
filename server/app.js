import express from 'express';
import path from 'node:path';
import { ROOT } from './db/connection.js';
import { AppError } from './lib/errors.js';
import { attachUser, csrfGuard, rateLimit } from './auth/middleware.js';
import { purgeExpiredSessions } from './auth/session.js';

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

export function createApp({ logger = console } = {}) {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));
  app.disable('x-powered-by');

  // Baseline security headers. The CSP is strict: no inline scripts, no remote
  // origins, so a stored value can never execute in the admin's browser.
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '));
    next();
  });

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

  app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist'), {
    maxAge: '7d', index: false,
  }));
  // Fonts are content-addressed by weight and never change: cache them hard.
  app.use('/fonts', express.static(path.join(ROOT, 'public', 'fonts'), {
    maxAge: '365d', immutable: true, index: false,
  }));
  // Application code revalidates on every load, so a deployed fix is picked up
  // immediately instead of being masked by a stale cached module.
  app.use(express.static(path.join(ROOT, 'public'), {
    index: 'index.html', maxAge: 0, etag: true, lastModified: true,
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown endpoint' } });
  });

  // The SPA owns client-side routing.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

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
    try { purgeExpiredSessions(); } catch { /* housekeeping is best-effort */ }
  }, 60 * 60 * 1000);
  timer.unref();
  return timer;
}
