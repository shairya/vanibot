// One-time database setup for a PostgreSQL you installed yourself (Windows, Mac, Linux or a VPS).
// Connects as the PostgreSQL admin user and creates the app's own login role and database from DATABASE_URL.
// The app role is NOT a superuser, so row-level security keeps every company's data apart.
// Also installs pgvector when it is available (optional: without it, knowledge search uses keywords only).
//
// Usage: pnpm db:setup   (uses DATABASE_ADMIN_URL from .env, default postgres://postgres:postgres@localhost:5432/postgres)
import pg from "pg";

const appUrl = process.env.DATABASE_URL;
if (!appUrl) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
const adminUrl = process.env.DATABASE_ADMIN_URL || "postgres://postgres:postgres@localhost:5432/postgres";

const app = new URL(appUrl);
const role = decodeURIComponent(app.username);
const password = decodeURIComponent(app.password);
const database = app.pathname.replace(/^\//, "");
const ident = /^[a-z_][a-z0-9_]*$/;
if (!ident.test(role) || !ident.test(database)) throw new Error("Use only lowercase letters, digits and _ for the user and database names in DATABASE_URL.");
if (!password) throw new Error("DATABASE_URL needs a password, e.g. postgres://vanibot:vanibot@localhost:5432/vanibot");
if (role === new URL(adminUrl).username) throw new Error(`DATABASE_URL must use its own user (e.g. vanibot), not the admin user "${role}".`);
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";

async function connect(url: string) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (err) {
    console.error(`\nCould not connect to PostgreSQL as the admin user (${new URL(url).username}@${new URL(url).host}).`);
    console.error("Check that PostgreSQL is running and set DATABASE_ADMIN_URL in .env to the password you chose when installing it,");
    console.error("for example: DATABASE_ADMIN_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/postgres\n");
    throw err;
  }
  return client;
}

async function main() {
  const admin = await connect(adminUrl);
  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (exists.rowCount) {
    await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS`);
    console.log(`Role "${role}" already exists (password updated).`);
  } else {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(password)} NOSUPERUSER NOBYPASSRLS`);
    console.log(`Created role "${role}".`);
  }
  const db = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (db.rowCount) console.log(`Database "${database}" already exists.`);
  else {
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    console.log(`Created database "${database}".`);
  }
  await admin.end();

  // Extensions need the admin user, inside the app database.
  const adminInApp = new URL(adminUrl);
  adminInApp.pathname = "/" + database;
  const client = await connect(adminInApp.toString());
  const available = await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
  if (available.rowCount) {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    // If pgvector was installed after the tables were created, add the search column now.
    const table = await client.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'chunks'");
    const column = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'chunks' AND column_name = 'embedding'");
    if (table.rowCount && !column.rowCount) {
      await client.query("ALTER TABLE chunks ADD COLUMN embedding vector(1024)");
      await client.query("CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)");
    }
    console.log("pgvector is installed: meaning-based search is available (with a VOYAGE_API_KEY).");
  } else {
    console.log("pgvector is not installed: that's fine, knowledge search will use keywords.");
  }
  await client.end();
  console.log("\nDatabase ready. Next: pnpm db:migrate");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
