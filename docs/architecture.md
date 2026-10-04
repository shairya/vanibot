# vanibot architecture

vanibot is a subscription SaaS. Any company (insurance, lending, banking, medical billing, anything else) signs up or is set up by the vanibot team, picks an industry template, adds its own documents, and gets an AI assistant that can **chat on WhatsApp** (text and voice notes), **chat on its website**, and **talk by voice in the browser**. Phone calls come in the next phase. The assistant answers only from that company's knowledge and takes actions such as capturing leads and handing off to a human.

vanibot is a standalone product. It has no built-in dependency on any one customer's CRM; leads are stored in vanibot and can optionally be pushed to any system through a generic, signed webhook.

## How "training per industry" works

There is no model fine-tuning. Each bot's behaviour is three layers combined at runtime:

| Layer | Owned by | Where | Contents |
|---|---|---|---|
| Industry template | vanibot | `apps/api/src/templates/index.ts` | Persona, safety rules, default lead fields, consent wording, suggested questions |
| Bot settings | The customer or the vanibot team | Dashboard, Behaviour and Channels tabs (`bots.config`) | Bot and company name, greeting, extra instructions, hours, lead fields, colours, channels, default language, voice |
| Knowledge | The customer | Dashboard, Knowledge tab (`documents`, `chunks`) | Uploaded PDF/DOCX/HTML/TXT, web pages, Q&A pairs; searched for every message |

Adding an industry means adding one template entry. Customers improve their bot through the "questions the bot couldn't answer" list on the Knowledge tab.

Templates today: General business, Medical bill discounts, Insurance, Loans and lending, Banking.

## Components

```
 WhatsApp customer          Website visitor              Company admin / vanibot team
 ┌───────────────┐         ┌──────────────┐             ┌──────────────────────┐
 │ Meta WhatsApp │         │ widget.js    │             │ Dashboard (React)    │
 │ Cloud API     │         │ text + voice │             │ Website (static)     │
 └──────┬────────┘         └──────┬───────┘             └──────────┬───────────┘
        │ signed webhook          │ SSE stream                     │ REST + JWT
 ┌──────▼─────────────────────────▼────────────────────────────────▼──────────┐
 │ API (Node, Fastify). Every request runs in a database isolation context.   │
 │  WhatsApp webhook: verify signature, route by phone number ID, de-dupe,    │
 │  queue. Job worker: transcribe voice note → Claude turn → voice reply      │
 │  (Sarvam text-to-speech) + text reply. Also document ingestion, lead       │
 │  webhooks, data retention cleanup.                                         │
 │  Orchestrator: frozen system prompt + tools per conversation, knowledge    │
 │  per message, Claude tool-use loop. Tools: capture_lead, handoff_to_human  │
 └──────┬──────────────────────┬─────────────────────┬────────────────────────┘
 ┌──────▼──────────┐   ┌───────▼────────┐   ┌────────▼────────┐
 │ Postgres 16     │   │ Claude API     │   │ Sarvam AI       │
 │ (+ pgvector,    │   │ (+ Voyage AI   │   │ speech-to-text, │
 │  optional) RLS  │   │ embeddings,    │   │ text-to-speech  │
 │                 │   │ optional)      │   └─────────────────┘
 └─────────────────┘   └────────────────┘
```

### Tenant isolation
- One database; every company-owned table has `tenant_id`.
- **Row-level security** on every company table (`migrations/002_...sql`). Each query runs in a transaction that sets `app.tenant_id`; Postgres then hides every other company's rows and refuses writes into them. With no company set, queries see nothing. `FORCE ROW LEVEL SECURITY` applies this to the table owner too.
- The API connects as the `vanibot` role, which is neither superuser nor BYPASSRLS. In production the API refuses to start otherwise.
- Code that must cross companies runs inside `asSystem(...)` and is kept small: login and sign-up, routing a WhatsApp number or widget key to its company, the job worker claiming jobs (each job then runs as its company), and the vanibot team console.
- Application queries still filter by `tenant_id` as a second layer. Tests in `apps/api/test/phase1.test.ts` check that a company can't read or write another company's rows, through SQL and through the API.
- vanibot team members (`users.is_platform_admin`) can act for a company with the `X-Act-As-Tenant` header; for everyone else that header is rejected.
- WhatsApp access tokens are encrypted at rest (AES-256-GCM, `APP_ENCRYPTION_KEY`).
- Conversations older than the company's retention period (default 365 days) are deleted hourly. Leads stay until the company deletes them.

### Channels and plans
- A company's plan gives it channels: `web` (website chat), `whatsapp` (WhatsApp text), `voice` (WhatsApp voice notes and website voice). The vanibot team can change them per company.
- Each bot has its own switches. A channel works only when both the company and the bot allow it, so a company can be chat only, voice only, or both.
- Limits per plan: bots, conversations a month, voice notes a month, documents.

### WhatsApp
- One Meta app for vanibot; each company's number (phone number ID + encrypted token) is stored on its bot.
- `POST /v1/whatsapp/webhook` checks `X-Hub-Signature-256` against the raw body, records each message ID once (Meta retries), queues a job and answers Meta at once.
- Messages from the same customer within 24 hours continue one conversation (WhatsApp's customer-service window).
- Without a token, a bot runs in test mode and logs replies instead of sending them.

### Conversations and the AI
- When a conversation starts, the system prompt (template + settings + channel style + language rule) and the tool list are built once and stored on it. They never change mid-conversation, which keeps Claude's prompt cache warm.
- The assistant always says it is an AI if asked and never claims to be human.
- For each message, matching knowledge is retrieved (Postgres full-text search, plus vector search with a Voyage key) and placed in that user turn as a `<knowledge>` block.
- Claude's replies, including thinking and tool-call blocks, are stored exactly as received and replayed unchanged.
- Model `claude-opus-5-5` at `low` effort by default. If Claude declines a request, the customer gets a polite fallback message; there is no retry on another model.

### Voice
- **WhatsApp voice notes:** the audio is downloaded from Meta, transcribed by Sarvam (language detected automatically), answered, turned into speech in the detected language, and sent back as an audio message followed by the text.
- **Browser voice:** the widget's microphone uses the browser's speech recognition and speech synthesis.
- **Phone (next phase):** Twilio routes exist but only load with `PHONE_ENABLED=true`.

### Actions
| Tool | What it does |
|---|---|
| `capture_lead` | Validates the fields defined for the bot, requires explicit consent, saves the lead, sends `lead.created` to the webhook |
| `handoff_to_human` | Marks the conversation for follow-up and sends `handoff.requested` |

Webhooks are signed: `X-Vanibot-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)` with `X-Vanibot-Timestamp`. Failed deliveries retry with backoff (6 attempts).

Later: book a callback (calendar), check application/claim status (customer API), native CRM connectors (HubSpot, Salesforce, Zoho) as add-ons.

### Payments
None in the pilot; the vanibot team assigns plans. Razorpay comes next, then international payments.

## Compliance notes
- India's Digital Personal Data Protection Act, 2023: collect only the lead fields needed, record consent (the lead tool requires it), honour deletion requests, and keep a retention period. The website privacy notice and terms are drafts for a lawyer to review.
- Data is stored in India (pilot hosting choice). Claude and Sarvam process messages; Claude processing is outside India in phase 1, accepted for the pilot.
- WhatsApp: follow Meta's Business and Commerce policies; business-started messages need approved templates (not used yet).
- Medical billing: the template forbids asking for diagnoses, policy numbers, Aadhaar or PAN.
- Lending, insurance and banking templates forbid approving loans, confirming coverage, or asking for OTPs and account numbers.

## Next phases
1. Deploy on a Hostinger VPS in India: PostgreSQL with pgvector, Node, HTTPS domain, backups
2. Phone calls (realtime voice with an Indian telephony provider)
3. Razorpay subscriptions
4. WhatsApp templates for follow-ups, team members and roles per company, audit log
5. Analytics (resolution rate, lead conversion)
