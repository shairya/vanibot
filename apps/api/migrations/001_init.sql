-- vanibot initial schema. Every tenant-owned row carries tenant_id; all queries filter on it.
-- pgvector is optional: `pnpm db:setup` installs it when available, and the embedding column is added below only then.
-- gen_random_uuid() is built into PostgreSQL 13 and later.

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'trial',
  plan_status   text NOT NULL DEFAULT 'active',
  stripe_customer_id     text,
  stripe_subscription_id text,
  trial_ends_at timestamptz NOT NULL DEFAULT now() + interval '14 days',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text,
  role          text NOT NULL DEFAULT 'owner',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL,
  industry        text NOT NULL DEFAULT 'generic',
  public_key      text NOT NULL UNIQUE,
  -- Tenant overrides layered over the industry template (greeting, persona, lead fields, theme, ...)
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  webhook_url     text,
  webhook_secret  text NOT NULL,
  phone_number    text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bots_tenant_idx ON bots(tenant_id);
CREATE UNIQUE INDEX bots_phone_idx ON bots(phone_number) WHERE phone_number IS NOT NULL;

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind        text NOT NULL,            -- file | url | qa | text
  title       text NOT NULL,
  source      text,                     -- original filename or URL
  raw_text    text,
  status      text NOT NULL DEFAULT 'pending', -- pending | processing | ready | failed
  error       text,
  chunk_count int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_bot_idx ON documents(tenant_id, bot_id);

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal     int NOT NULL,
  content     text NOT NULL,
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
CREATE INDEX chunks_bot_idx ON chunks(tenant_id, bot_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin(tsv);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE chunks ADD COLUMN embedding vector(1024);
    CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
  END IF;
END $$;

CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel     text NOT NULL,            -- web | web_voice | phone
  visitor_id  text,
  caller      text,                     -- phone number for phone channel
  external_id text,                     -- e.g. Twilio CallSid
  -- Frozen at conversation start so the prompt prefix never changes mid-conversation
  system_prompt text NOT NULL,
  tools       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open', -- open | handoff | closed
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_bot_idx ON conversations(tenant_id, bot_id, created_at DESC);
CREATE UNIQUE INDEX conversations_external_idx ON conversations(bot_id, external_id) WHERE external_id IS NOT NULL;

-- Exact Claude message content (including thinking and tool blocks) replayed unchanged on each turn.
-- Stored as json (not jsonb) so the text is kept exactly as received.
CREATE TABLE messages (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,        -- user | assistant
  content         json NOT NULL,        -- Claude content blocks
  display_text    text,                 -- what the visitor said / saw, for the dashboard
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, id);

CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  fields          jsonb NOT NULL,
  consent         boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'new',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_bot_idx ON leads(tenant_id, bot_id, created_at DESC);

-- Simple Postgres-backed job queue (ingestion, webhook delivery). No Redis needed.
CREATE TABLE jobs (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,
  kind        text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'queued', -- queued | running | done | failed
  attempts    int NOT NULL DEFAULT 0,
  run_at      timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs(status, run_at);

CREATE TABLE usage_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bot_id      uuid,
  kind        text NOT NULL,            -- conversation | message | voice_minute
  quantity    numeric NOT NULL DEFAULT 1,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_tenant_idx ON usage_events(tenant_id, kind, created_at);
