/**
 * Scheduler — cron-based lifecycle runner + post-ingest markdown export trigger.
 *
 * This module wires up the two "phantom features" that had config but no runtime:
 * 1. Lifecycle schedule (config.lifecycle.schedule) → runs LifecycleEngine on cron
 * 2. Markdown export (config.markdownExport.enabled) → scheduleExport() after ingest
 */

import { Cron } from 'croner';
import type { CortexApp } from '../app.js';
import type { CortexConfig } from '../utils/config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

let lifecycleCron: Cron | null = null;

/**
 * Start the lifecycle cron job based on config.lifecycle.schedule.
 * Safe to call multiple times — stops previous job first.
 */
export function startLifecycleScheduler(cortex: CortexApp): void {
  stopLifecycleScheduler();

  const schedule = cortex.config.lifecycle?.schedule;
  if (!schedule) {
    log.info('Lifecycle schedule not configured, skipping');
    return;
  }

  try {
    lifecycleCron = new Cron(schedule, { timezone: 'UTC' }, async () => {
      log.info({ schedule }, 'Lifecycle cron triggered');
      try {
        const report = await cortex.lifecycle.run();
        log.info(
          {
            promoted: report.promoted,
            archived: report.archived,
            merged: report.merged,
            decayUpdated: report.decayUpdated,
          },
          'Lifecycle cron completed',
        );
      } catch (e: any) {
        log.error({ error: e.message }, 'Lifecycle cron failed');
      }
    });

    const next = lifecycleCron.nextRun();
    log.info({ schedule, nextRun: next?.toISOString() }, 'Lifecycle scheduler started');
  } catch (e: any) {
    log.error({ error: e.message, schedule }, 'Failed to start lifecycle scheduler (invalid cron?)');
  }
}

/**
 * Stop the lifecycle cron job.
 */
export function stopLifecycleScheduler(): void {
  if (lifecycleCron) {
    lifecycleCron.stop();
    lifecycleCron = null;
    log.info('Lifecycle scheduler stopped');
  }
}

/**
 * Restart the scheduler with new config (e.g. after config update from Dashboard).
 */
export function restartLifecycleScheduler(cortex: CortexApp): void {
  startLifecycleScheduler(cortex);
}

/**
 * Trigger markdown export after a successful ingest (debounced inside exporter).
 */
export function triggerMarkdownExport(cortex: CortexApp): void {
  if (cortex.config.markdownExport?.enabled) {
    cortex.exporter.scheduleExport();
  }
}
