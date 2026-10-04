-- Phase 1: row-level tenant isolation, per-company channels, vanibot team admins, WhatsApp, languages, retention.

-- ---------- vanibot team (platform) admins ----------
ALTER TABLE users ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false;

-- ---------- Per-company settings ----------
-- Channels the company has bought: any of 'web', 'whatsapp', 'voice'. Set from the plan; vanibot admins can override.
ALTER TABLE tenants ADD COLUMN channels text[] NOT NULL DEFAULT '{web,whatsapp,voice}';
ALTER TABLE tenants ADD COLUMN default_language text NOT NULL DEFAULT 'en-IN';
ALTER TABLE tenants ADD COLUMN data_retention_days int NOT NULL DEFAULT 365;
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active'; -- active | suspended
UPDATE tenants SET plan = 'pilot' WHERE plan = 'trial';
ALTER TABLE tenants ALTER COLUMN plan SET DEFAULT 'pilot';
-- Online payments are not used in the pilot (Razorpay comes next).
ALTER TABLE tenants DROP COLUMN stripe_customer_id;
ALTER TABLE tenants DROP COLUMN stripe_subscription_id;

-- ---------- WhatsApp Cloud API per bot ----------
ALTER TABLE bots ADD COLUMN whatsapp_phone_number_id text;
ALTER TABLE bots ADD COLUMN whatsapp_display_number text;
ALTER TABLE bots ADD COLUMN whatsapp_business_account_id text;
ALTER TABLE bots ADD COLUMN whatsapp_access_token_enc text; -- AES-256-GCM, key from APP_ENCRYPTION_KEY
CREATE UNIQUE INDEX bots_whatsapp_idx ON bots(whatsapp_phone_number_id) WHERE whatsapp_phone_number_id IS NOT NULL;

-- Meta may deliver the same webhook more than once; remember what we've handled.
CREATE TABLE whatsapp_inbound (
  message_id  text PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Conversation language detected from the customer (used for voice replies).
ALTER TABLE conversations ADD COLUMN language text;
ALTER TABLE conversations ADD COLUMN contact_name text;

-- ---------- Website demo requests (platform-level, not tenant data) ----------
CREATE TABLE demo_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  company     text NOT NULL,
  email       text NOT NULL,
  phone       text,
  interest    text,
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- Row-level security ----------
-- Every tenant-owned table only shows rows of the tenant named in app.tenant_id, unless app.bypass_rls = 'on'
-- (platform-level code paths). FORCE applies the rules to the table owner too. The app must connect as a role
-- that is neither superuser nor BYPASSRLS; the API refuses to start in production otherwise.
CREATE FUNCTION vanibot_tenant_visible(row_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.bypass_rls', true) = 'on'
      OR row_tenant = nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','bots','documents','chunks','conversations','messages','leads','usage_events','jobs','whatsapp_inbound']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (vanibot_tenant_visible(tenant_id)) WITH CHECK (vanibot_tenant_visible(tenant_id))', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (vanibot_tenant_visible(id)) WITH CHECK (vanibot_tenant_visible(id));

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON demo_requests
  USING (current_setting('app.bypass_rls', true) = 'on') WITH CHECK (current_setting('app.bypass_rls', true) = 'on');
