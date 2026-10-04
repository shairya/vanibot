# vanibot

AI chat and voice assistants for businesses, sold as a multi-tenant subscription (SaaS). Built for India first: WhatsApp, website, English and Indian languages.

- **WhatsApp first.** Each company connects its WhatsApp Business number through Meta's WhatsApp Cloud API.
- **Voice notes.** Customers can send WhatsApp voice notes. vanibot transcribes them (Sarvam AI), answers, and replies with a voice note plus text.
- **Website chat and voice.** A one-line chat bubble with a microphone button.
- **Answers from the company's own documents** (PDF, Word, web pages, Q&A), and **captures leads** with consent or hands off to a human.
- **Trained per industry.** Templates for medical bill discounts, insurance, lending, banking and general business.
- **Languages.** Replies in the customer's language and script: English, Hindi, Hinglish, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi and Odia.
- **Chat only, voice only, or both.** Channels are switched on per company (by plan) and per bot.
- **Strict tenant isolation.** Postgres row-level security keeps every company's data apart, even if application code forgets a filter.
- **vanibot team console.** The vanibot team sees every company, sets plans and channels, opens any company's dashboard to set bots up for them, and reads demo requests from the website.
- **Marketing website** with pricing, live demos, sign-up and a book-a-demo form.

Phone calls (Twilio) are kept for the next phase and are switched off by default (`PHONE_ENABLED=false`). There are no online payments in the pilot; Razorpay comes next.

See [docs/architecture.md](docs/architecture.md) for how it works.

```
apps/
  api/        Node + Fastify backend: chat engine, WhatsApp, speech, knowledge, leads, tenant isolation
  dashboard/  React app for companies and the vanibot team
  widget/     Embeddable chat + voice widget (builds to widget.js)
  website/    vanibot marketing website (home, pricing, demos, book a demo)
docker/       Database setup (creates the restricted "vanibot" database role)
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

```bash
node -v        # v20 or higher
pnpm -v
docker -v
```

> No Docker? Install PostgreSQL 16 with the pgvector extension, then run the commands in `docker/initdb/01-app-role.sh` as the postgres superuser. The app must connect as the non-superuser `vanibot` role, otherwise row-level security is skipped.

### 2. Get the code

```bash
git clone https://github.com/shairya/vanibot.git
cd vanibot
```

### 3. Configure

```bash
cp .env.example .env
```

Open `.env` and set:

- `ANTHROPIC_API_KEY`: your Claude API key.
- `JWT_SECRET`: any long random string (for example the output of `openssl rand -hex 32`).
- `APP_ENCRYPTION_KEY`: the output of `openssl rand -hex 32`. It encrypts WhatsApp access tokens.

Everything else can stay empty for now. Without WhatsApp keys, WhatsApp runs in test mode (replies are written to the API log). Without a Sarvam key, voice notes get a polite "please type your question" reply.

### 4. Install, start the database, and load the starting data

```bash
pnpm install
pnpm db:up          # starts Postgres + pgvector in Docker and creates the "vanibot" role
pnpm db:migrate     # creates the tables and the isolation rules
pnpm seed           # vanibot team admin, the OXXY pilot company, and the website demo bots
```

`pnpm seed` prints the logins and demo links:

| Who | Login |
|---|---|
| vanibot team (sees every company) | `admin@vanibot.local` / `admin12345` |
| OXXY (pilot company) | `oxxy@vanibot.local` / `oxxy12345` |

OXXY's knowledge is **sample text**. Replace it with OXXY's real documents on the bot's Knowledge tab before going live. Change these passwords before anyone else can reach the server.

### 5. Start everything

```bash
pnpm dev
```

| What | Where |
|---|---|
| API | http://localhost:4000 |
| Dashboard | http://localhost:5173 |
| Website | http://localhost:5174 |

The widget builder also runs, rebuilding `widget.js` when it changes.

### 6. Try it

1. Open the website at http://localhost:5174, go to **Live demos** and chat with the demo assistants.
2. Open the dashboard at http://localhost:5173 and log in as the vanibot team. **vanibot team** lists every company. Click **Open** next to OXXY to work inside OXXY's account.
3. Open **OXXY Assistant**: upload documents on **Knowledge**, choose channels and the default language on **Channels & language**, and click **Try it on a demo page**.
4. Ask for a call back and give a name and number. The lead appears on **Leads**.

---

## Connect WhatsApp

You need a Meta Business account, a Meta developer app with the WhatsApp product, and a phone number that is not in use on the WhatsApp app. Meta has to reach the API over HTTPS, so while developing use a tunnel.

1. Run `ngrok http 4000` (or `cloudflared tunnel --url http://localhost:4000`) and set `PUBLIC_URL` in `.env` to the https URL.
2. In the Meta app, open **App settings > Basic** and copy the **App secret** into `WHATSAPP_APP_SECRET`. Choose any string for `WHATSAPP_VERIFY_TOKEN`. Restart `pnpm dev`.
3. In **WhatsApp > Configuration**, set the callback URL to `https://YOUR-URL/v1/whatsapp/webhook`, the verify token to your `WHATSAPP_VERIFY_TOKEN`, and subscribe to the **messages** field.
4. In **WhatsApp > API setup**, copy the **Phone number ID** and **WhatsApp Business Account ID**. Create a permanent token (Business settings > System users > Generate token, with `whatsapp_business_messaging` permission).
5. In the dashboard, open the bot's **WhatsApp** tab, paste the IDs and the token, and save.
6. Message the number from your phone. Try a voice note too.

One Meta app serves every company; each company's number and token are stored on its bot (the token encrypted).

## Voice notes (Sarvam AI)

1. Create an API key at https://dashboard.sarvam.ai and put it in `SARVAM_API_KEY`.
2. Restart. Voice notes are now transcribed (language detected automatically), and the bot replies with a voice note in the customer's language plus the same text.
3. Optional: pick a voice per bot on **Channels & language**, or a default with `SARVAM_TTS_SPEAKER`.

Speech sits behind a small interface (`apps/api/src/core/speech.ts`), so another provider can be added later.

## Plans and channels

Plans are in `apps/api/src/core/plans.ts`: **Pilot** (free, everything on), **Chat** (website + WhatsApp text), **Voice** (voice notes + website voice), **Chat + Voice**. Prices are placeholders. In the pilot the vanibot team sets each company's plan and channels on the **vanibot team** page. A company only gets a channel when both its plan and the bot's switch allow it.

## Sending leads to another system

On the bot's **Website & leads** tab, set a webhook URL. vanibot sends a signed POST for each `lead.created` and `handoff.requested` event:

```json
{ "event": "lead.created", "bot_id": "...", "created_at": "...",
  "data": { "lead_id": "...", "conversation_id": "...", "channel": "whatsapp", "consent": true,
            "fields": { "name": "...", "phone": "...", "summary": "..." } } }
```

Verify it (Node):

```js
import { createHmac, timingSafeEqual } from "node:crypto";
const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
  .update(req.headers["x-vanibot-timestamp"] + "." + rawBody).digest("hex");
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-vanibot-signature"]));
```

## Better search (optional)

Without a key the bot searches knowledge by keywords. For meaning-based search add a [Voyage AI](https://www.voyageai.com) key as `VOYAGE_API_KEY`, restart, and re-add documents.

## Customising

- **New industry:** add an entry to `apps/api/src/templates/index.ts`.
- **Model and cost:** `LLM_MODEL` (default `claude-opus-5-5`) and `LLM_EFFORT` (`low`, `medium`, `high`). If Claude declines a request, the customer gets a polite reply; there is no retry on another model.
- **Website:** pages are plain HTML in `apps/website`. Set `VITE_API_URL` and `VITE_DASHBOARD_URL` when building for production.

## Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Runs the API, dashboard, website and widget builder |
| `pnpm test` | Runs the API tests (needs the database running) |
| `pnpm typecheck` | Type-checks all apps |
| `pnpm build` | Production build of all apps |
| `pnpm db:migrate` | Applies new database migrations |
| `docker compose down` | Stops the database (data is kept) |
| `docker compose down -v` | Stops the database and **deletes** all data |

## Troubleshooting

- **"Missing required environment variable"**: you skipped step 3, or `.env` is not in the `vanibot` folder.
- **"bypasses row-level security" warning**: the API is connecting as a superuser. Use `postgres://vanibot:vanibot@localhost:5432/vanibot`. In production the API refuses to start in this case.
- **Database created before this version**: the `vanibot` role is only created on a fresh volume. Run `docker compose down -v` (deletes local data), then `pnpm db:up`, `pnpm db:migrate`, `pnpm seed`.
- **`ECONNREFUSED 127.0.0.1:5432`**: start Docker Desktop, then `pnpm db:up`.
- **WhatsApp verification fails**: `WHATSAPP_VERIFY_TOKEN` in `.env` must match what you typed in Meta, and `PUBLIC_URL` must be the tunnel URL.
- **No WhatsApp reply**: check the API log. "dry run" means the bot has no access token saved; "unknown number" means the phone number ID on the bot doesn't match.
- **The bot says "I'm having trouble right now"**: usually a missing or wrong `ANTHROPIC_API_KEY`.
- **"Widget not built yet"**: run `pnpm --filter @vanibot/widget build`, or keep `pnpm dev` running.
