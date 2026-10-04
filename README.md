# vanibot

An AI chat and voice assistant that any company can add to its website or phone line, sold as a subscription.

- **Answers from the company's own documents.** Customers upload PDFs, Word files and web pages, or write Q&A pairs.
- **Takes actions.** It captures leads (with consent) and hands off to a human when needed.
- **Trained per industry.** Templates are included for general business, medical bill discounts, insurance, lending and banking.
- **Chat and voice.** It runs as a website chat widget with a microphone button, and as a phone bot through Twilio.
- **Multi-tenant SaaS.** Customers sign up themselves, get plans and usage limits, and pay through Stripe.

See [docs/architecture.md](docs/architecture.md) for how it works.

```
apps/
  api/        Node + Fastify backend: chat engine, knowledge, leads, voice, billing
  dashboard/  React admin app for customers
  widget/     The embeddable chat + voice widget (builds to widget.js)
docs/         Architecture
```

---

## Run it on your computer

### 1. Install the tools (one time)

| Tool | Why | Get it |
|---|---|---|
| Node.js 20 or newer | Runs the app | https://nodejs.org (LTS) |
| pnpm | Installs packages | Run `corepack enable` after installing Node |
| Docker Desktop | Runs the database | https://www.docker.com/products/docker-desktop |
| A Claude API key | The AI | https://console.anthropic.com > API Keys |

Check that they work:

```bash
node -v        # v20 or higher
pnpm -v
docker -v
```

> No Docker? Install PostgreSQL 16 and the pgvector extension yourself, create a database, and put its address in `DATABASE_URL` in step 3.

### 2. Get the code

Copy the `vanibot` folder to your computer, or clone it from GitHub once it's in a repository. Then open a terminal in that folder.

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set:

- `ANTHROPIC_API_KEY`: your Claude API key.
- `JWT_SECRET`: any long random string, for example the output of `openssl rand -hex 32`.

Leave everything else as it is for now.

### 4. Install, start the database, and load demo data

```bash
pnpm install
pnpm db:up          # starts Postgres + pgvector in Docker
pnpm db:migrate     # creates the tables
pnpm seed           # creates a demo account and a medical-bill-discount bot
```

`pnpm seed` prints the demo login and a demo page link.

### 5. Start everything

```bash
pnpm dev
```

This starts three things together:

- the API at http://localhost:4000
- the dashboard at http://localhost:5173
- the widget builder, which rebuilds `widget.js` when you change it

### 6. Try it

1. Open http://localhost:5173 and log in with `demo@vanibot.local` / `demo12345` (or create your own account).
2. Click the bot **Billie**, then **Try it on a demo page**. Chat with it, or click the microphone to talk to it (use Chrome or Edge).
3. Say you'd like a free bill review and give a name and phone number. The lead appears on the **Leads** page.
4. On the **Knowledge** tab, upload your own documents. The bot uses them right away.

To put the bot on any website, copy the one-line script from **Install & leads** and paste it before `</body>`.

---

## Optional features

### Better search (semantic)

Without this key, the bot searches knowledge by keywords. For smarter, meaning-based search, add a [Voyage AI](https://www.voyageai.com) key to `.env` as `VOYAGE_API_KEY`, then restart `pnpm dev` and re-add your documents.

### Sending leads to your own system

On the bot's **Install & leads** tab, set a webhook URL. vanibot sends a POST for each `lead.created` and `handoff.requested` event:

```json
{ "event": "lead.created", "bot_id": "...", "created_at": "...",
  "data": { "lead_id": "...", "conversation_id": "...", "channel": "web", "consent": true,
            "fields": { "name": "...", "phone": "...", "summary": "..." } } }
```

To check that a request really came from vanibot (Node example):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
  .update(req.headers["x-vanibot-timestamp"] + "." + rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-vanibot-signature"]));
```

### Phone voice bot (Twilio)

Twilio has to reach your computer, so you need a public tunnel while developing:

1. Run `ngrok http 4000` (or `cloudflared tunnel --url http://localhost:4000`) and copy the https URL.
2. In `.env`, set `PUBLIC_URL` to that URL and `TWILIO_AUTH_TOKEN` to your Twilio auth token. Restart `pnpm dev`.
3. Buy a number in Twilio. Under **Voice Configuration**:
   - set **A call comes in** to Webhook, HTTP POST, `https://YOUR-TUNNEL/v1/voice/twilio/incoming`
   - set **Call status changes** to `https://YOUR-TUNNEL/v1/voice/twilio/status`
4. In the dashboard, open the bot's **Phone voice** tab, enter the number (for example `+15551234567`), and save.
5. Call the number.

Twilio waits up to 15 seconds for each reply. If replies feel slow, keep `LLM_EFFORT=low`.

### Subscriptions (Stripe)

1. In Stripe (test mode), create three recurring prices for Starter, Growth and Business. Put their IDs in `.env` as `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH` and `STRIPE_PRICE_BUSINESS`, and add `STRIPE_SECRET_KEY`.
2. Forward Stripe webhooks to your computer with the [Stripe CLI](https://docs.stripe.com/stripe-cli):
   `stripe listen --forward-to localhost:4000/api/billing/webhook`
   Then put the `whsec_...` value it prints into `STRIPE_WEBHOOK_SECRET`.
3. Restart `pnpm dev`. The **Plan & billing** page now opens Stripe Checkout.

Plan limits (bots, conversations, voice minutes, documents) are set in `apps/api/src/core/plans.ts`.

---

## Customising

- **New industry:** add an entry to `apps/api/src/templates/index.ts`. It then appears in the dashboard.
- **Model and cost:** `LLM_MODEL` (default `claude-opus-5-5`) and `LLM_EFFORT` (`low`, `medium` or `high`) in `.env`. `LLM_FALLBACKS=default` lets Claude retry a declined request on another model; set it to `off` to disable.
- **Widget look:** colours and position are per bot in the dashboard. Widget code is in `apps/widget/src/widget.ts`.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the API, dashboard and widget builder |
| `pnpm test` | Runs the API tests (needs the database running) |
| `pnpm typecheck` | Type-checks all apps |
| `pnpm build` | Production build of all apps |
| `pnpm db:migrate` | Applies new database migrations |
| `docker compose down` | Stops the database (your data is kept) |
| `docker compose down -v` | Stops the database and **deletes** all data |

## Troubleshooting

- **"Missing required environment variable"**: you skipped step 3, or `.env` is not in the `vanibot` folder.
- **`ECONNREFUSED 127.0.0.1:5432`**: the database isn't running. Start Docker Desktop, then run `pnpm db:up`.
- **"Widget not built yet"**: run `pnpm --filter @vanibot/widget build`, or keep `pnpm dev` running.
- **The bot says "I'm having trouble right now"**: check the API terminal. It's usually a missing or wrong `ANTHROPIC_API_KEY`, or a model your key can't use. If it mentions `fallbacks`, set `LLM_FALLBACKS=off`.
- **The microphone button is missing**: your browser has no speech recognition. Use Chrome or Edge.
- **"This assistant is not enabled for this website"**: the page's domain isn't in the bot's allowed domains. Clear the list while testing.
