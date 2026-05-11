import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import { getQueue, isQueueInitialized, QUEUES } from './index.js';
import { logger } from '../config/logger.js';

/**
 * Bull Board Dashboard Setup
 *
 * Provides a web UI for monitoring queues:
 * - Active jobs, pending, completed, failed
 * - Job details, logs, retry options
 * - Manual job control (pause, resume, clear)
 *
 * Access at: /admin/queues
 *
 * Called AFTER initializeQueues() so all queues exist in the registry.
 * Works even when DISABLE_QUEUE_WORKERS=true — queues are created (Redis
 * connection only), workers are not. Dashboard is read-only in that mode.
 */
export function setupQueueDashboard(app) {
  try {
    const adapters = Object.values(QUEUES)
      .filter((name) => {
        const ready = isQueueInitialized(name);
        if (!ready) logger.warn({ queue: name }, 'queue not ready for dashboard — skipping');
        return ready;
      })
      .map((name) => new BullMQAdapter(getQueue(name)));

    if (adapters.length === 0) {
      logger.warn('no queues available for dashboard — skipping mount');
      return;
    }

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');

    createBullBoard({ queues: adapters, serverAdapter });
    app.use('/admin/queues', serverAdapter.getRouter());

    logger.info({ queues: adapters.length }, 'queue dashboard mounted at /admin/queues');
  } catch (err) {
    logger.error({ err }, 'failed to setup queue dashboard');
    // Non-fatal: dashboard is monitoring-only
  }
}
