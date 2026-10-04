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
docs/         Architecture
```

---

## Run it on your computer

These steps are written for **Windows** (PowerShell). Mac and Linux work the same way; use your usual terminal.

### 1. Install the tools (one time)

| Tool | Why | Get it |
|---|---|---|
| Node.js 20 or newer (LTS) | Runs the app | https://nodejs.org |
| Git | Downloads the code | https://git-scm.com/download/win |
| PostgreSQL 16 or 17 | The database | https://www.postgresql.org/download/windows/ (EDB installer) |
| A Claude API key | The AI | https://console.anthropic.com > API Keys |

When the PostgreSQL installer asks:
- **Password for the `postgres` user:** choose one using only letters and digits, and keep it. You need it in step 3.
- **Port:** keep `5432`.
- **Stack Builder** at the end: skip it.

Then open **PowerShell as Administrator** once and run `corepack enable` (this installs `pnpm`). Close it and open a normal PowerShell. Check:

```powershell
node -v        # v20 or higher
pnpm -v
```

### 2. Get the code

```powershell
git clone https://github.com/shairya/vanibot.git
cd vanibot
git checkout vanibot-phase-1
```

### 3. Configure

```powershell
copy .env.example .env
notepad .env
```

Set these lines and save:

- `DATABASE_ADMIN_URL`: replace `YOUR_POSTGRES_PASSWORD` with the password from step 1.
- `ANTHROPIC_API_KEY`: your Claude API key.
- `JWT_SECRET` and `APP_ENCRYPTION_KEY`: run this twice and paste one result into each:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `SARVAM_API_KEY`: your Sarvam key (for voice notes). `.env` never goes to GitHub, so keys are safe here.

Leave `DATABASE_URL` as it is. Without WhatsApp keys, WhatsApp runs in test mode (replies are written to the terminal).

### 4. Install and create the database

```powershell
pnpm install
pnpm db:setup       # creates the "vanibot" database and its own restricted login
pnpm db:migrate     # creates the tables and the rules that keep companies' data apart
pnpm seed           # vanibot team admin, the OXXY pilot company, and the website demo bots
```

`pnpm db:setup` also turns on **pgvector** if it is installed. It's optional: without it, knowledge search uses keywords, which works well for small document sets. (pgvector is easy to add on the Hostinger server later; on Windows it needs a separate build, so skip it for now.)

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

Without it the bot searches knowledge by keywords. For meaning-based search you need both pgvector in PostgreSQL (run `pnpm db:setup` again after installing it) and a [Voyage AI](https://www.voyageai.com) key as `VOYAGE_API_KEY`. Restart and re-add documents.

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
| `pnpm db:setup` | Creates the database and app login (safe to run again) |

## Troubleshooting

- **"Missing required environment variable"**: you skipped step 3, or `.env` is not in the `vanibot` folder.
- **"bypasses row-level security" warning**: the API is connecting as a superuser. Keep `DATABASE_URL=postgres://vanibot:vanibot@localhost:5432/vanibot`. In production the API refuses to start in this case.
- **`pnpm db:setup` says "password authentication failed"**: the password in `DATABASE_ADMIN_URL` doesn't match the one you chose when installing PostgreSQL.
- **`ECONNREFUSED 127.0.0.1:5432`**: PostgreSQL isn't running. On Windows open **Services**, find `postgresql-x64-16` (or 17) and click Start.
- **`pnpm` is not recognized**: run `corepack enable` in PowerShell as Administrator, or `npm install -g pnpm`.
- **WhatsApp verification fails**: `WHATSAPP_VERIFY_TOKEN` in `.env` must match what you typed in Meta, and `PUBLIC_URL` must be the tunnel URL.
- **No WhatsApp reply**: check the API log. "dry run" means the bot has no access token saved; "unknown number" means the phone number ID on the bot doesn't match.
- **The bot says "I'm having trouble right now"**: usually a missing or wrong `ANTHROPIC_API_KEY`.
- **"Widget not built yet"**: run `pnpm --filter @vanibot/widget build`, or keep `pnpm dev` running.
