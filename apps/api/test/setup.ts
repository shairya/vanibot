import { existsSync } from "node:fs";

// Tests run against the local database from .env (see README). They create and clean up their own tenant.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
process.env.VOYAGE_API_KEY = "";
process.env.SPEECH_PROVIDER = "none";
process.env.WHATSAPP_APP_SECRET = "test-app-secret";
process.env.WHATSAPP_VERIFY_TOKEN = "test-verify";
process.env.APP_ENCRYPTION_KEY = "11".repeat(32);
process.env.WHATSAPP_GRAPH_BASE = "http://127.0.0.1:4599";
process.env.LOG_LEVEL = "silent";
