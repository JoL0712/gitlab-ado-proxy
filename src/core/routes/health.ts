/**
 * Health check route.
 */

import { Hono } from 'hono';
import type { Env } from './env.js';

export function registerHealth(app: Hono<Env>): void {
  app.get('/health', (c) => {
    return c.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
}
