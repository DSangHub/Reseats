import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { bootstrapProviders } from './services/cards/index.js';
import { startWebhookWorker } from './services/webhooks/dispatcher.js';

async function main(): Promise<void> {
  const cfg = config();
  bootstrapProviders();

  const app = await buildApp();
  const worker = cfg.WEBHOOK_WORKER_ENABLED ? startWebhookWorker() : null;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    worker?.stop();
    await app.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
