import { existsSync } from "node:fs";

// Tests run against the local database from .env (see README). They create and clean up their own tenant.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");
process.env.VOYAGE_API_KEY = "";
process.env.LLM_FALLBACKS = "off";
