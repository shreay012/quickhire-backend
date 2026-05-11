// Sentry must init before any other imports that could throw
import { initSentry } from './config/sentry.js';
initSentry();

import http from 'http';
import { buildApp } from './app.js';
import { connectDb, closeDb } from './config/db.js';
import { closeRedis } from './config/redis.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { attachSocketIO, getIO } from './socket/index.js';
import { startQueueWorkers, stopQueueWorkers } from './queue/setup.js';
import { initializeQueues } from './queue/index.js';
import { setupQueueDashboard } from './queue/dashboard.js';
import { initMeilisearch } from './config/meilisearch.js';

async function main() {
  await connectDb();

  // Always initialize queue objects (just Redis stubs — no processors).
  // This must happen before setupQueueDashboard() and before any route
  // handler calls enqueueJob(). When DISABLE_QUEUE_WORKERS=true the
  // worker processors are skipped below but the queues still exist so
  // the dashboard and enqueueJob() can reference them safely.
  await initializeQueues();

  const app = buildApp();
  const server = http.createServer(app);

  attachSocketIO(server);
  app.set('io', getIO());

  // Non-blocking — search degrades to MongoDB fallback if unavailable
  initMeilisearch().catch((e) =>
    logger.warn({ err: e.message }, 'meilisearch init skipped'),
  );

  // Start worker processors only when not explicitly disabled.
  // Queue objects already exist above so stopping workers doesn't
  // affect enqueueJob() callers or the dashboard.
  if (env.DISABLE_QUEUE_WORKERS === 'true') {
    logger.info('queue workers disabled (DISABLE_QUEUE_WORKERS=true) — skipping');
  } else {
    await startQueueWorkers();
  }

  // Mount dashboard — queues are guaranteed to exist at this point
  setupQueueDashboard(app);

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'quickhire api started');
  });

  const shutdown = async (sig) => {
    logger.warn({ sig }, 'graceful shutdown initiated');

    server.close();

    try {
      const io = getIO();
      io?.emit('server:shutdown', { at: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 2000));
      io?.close();
    } catch {}

    await Promise.race([
      stopQueueWorkers(),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);

    await closeDb();
    await closeRedis();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error(
      { reason: reason && (reason.stack || reason.message || reason) },
      'unhandledRejection (continuing)',
    );
  });

  process.on('uncaughtException', (err) => {
    const msg = String(err?.message || err);
    const transient =
      /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|max requests limit|Connection is closed|UPSTASH/i.test(msg);
    if (transient) {
      logger.warn({ err: msg, code: err?.code }, 'transient external-service error (continuing)');
      return;
    }
    logger.fatal({ err }, 'uncaughtException');
    shutdown('uncaughtException');
  });
}

main().catch((e) => {
  logger.fatal({ err: e }, 'failed to start');
  process.exit(1);
});
