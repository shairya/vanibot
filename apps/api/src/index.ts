import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startWorker } from "./core/jobs.js";

const app = await buildApp();
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
