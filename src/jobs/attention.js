#!/usr/bin/env node
require('dotenv').config();
const pool = require('../helpers/db');
const { runOnce } = require('../services/attention/worker');

async function main() {
  // Bounded invocation; run every minute using the deployment's scheduler.
  // Limits defer work in the durable inbox rather than discard events.
  const report = await runOnce();
  console.log('[attention]', JSON.stringify(report));
  if (report.failed || report.retried) process.exitCode = 1;
}

if (require.main === module) main().catch(() => {
  console.error('[attention] Worker failed; durable work remains for retry');
  process.exitCode = 1;
}).finally(() => pool.end());
module.exports = { main };
