/**
 * What the browser is served: the security headers every response carries,
 * and the single-page frontend itself.
 *
 * Shared by the API (app.js, which serves the frontend too during development
 * and in the tests) and the standalone frontend service (frontend.js), so the
 * two can never send different headers or cache rules for the same file.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/*
 * Baseline security headers. The CSP is strict: no inline scripts, no remote
 * origins, so a stored value can never execute in the admin's browser.
 */
export function securityHeaders(req, res, next) {
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
}

export function mountFrontend(app) {
  app.use('/vendor', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist'), {
    maxAge: '7d', index: false,
  }));
  // Fonts are content-addressed by weight and never change: cache them hard.
  app.use('/fonts', express.static(path.join(PUBLIC, 'fonts'), {
    maxAge: '365d', immutable: true, index: false,
  }));
  // Application code revalidates on every load, so a deployed fix is picked up
  // immediately instead of being masked by a stale cached module.
  app.use(express.static(PUBLIC, {
    index: 'index.html', maxAge: 0, etag: true, lastModified: true,
  }));
  // The SPA owns client-side routing.
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(PUBLIC, 'index.html'));
  });
}
