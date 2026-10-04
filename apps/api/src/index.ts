import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startWorker } from "./core/jobs.js";
import { setWhatsAppLogger } from "./core/whatsapp.js";
import { checkIsolationEnforced } from "./db.js";

const app = await buildApp();

// Tenant isolation depends on row-level security, which superusers and BYPASSRLS roles silently skip.
const isolation = await checkIsolationEnforced();
if (!isolation.ok) {
  const msg = `Database role "${isolation.role}" bypasses row-level security, so companies' data would not be kept apart. Connect as the non-superuser "vanibot" role (see README).`;
  if (config.production) {
    app.log.fatal(msg);
    process.exit(1);
  }
  app.log.warn(msg);
}
if (config.production && !/^[0-9a-fA-F]{64}$/.test(config.encryptionKey)) {
  app.log.fatal("APP_ENCRYPTION_KEY must be 64 hex characters in production.");
  process.exit(1);
}

setWhatsAppLogger(app.log);
const stopWorker = startWorker(app.log);

const shutdown = async () => {
  stopWorker();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: "0.0.0.0" });
app.log.info(`vanibot API on ${config.publicUrl}`);
