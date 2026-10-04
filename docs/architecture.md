# vanibot architecture

vanibot is a subscription SaaS. Any company (insurance, lending, banking, medical billing, anything else) signs up, picks an industry template, adds its own documents, and gets an AI assistant that can **chat on its website**, **talk by voice in the browser**, and **answer phone calls**. The assistant answers only from that company's knowledge and takes actions such as capturing leads and handing off to a human.

vanibot is a standalone product. It has no built-in dependency on any one customer's CRM; leads are stored in vanibot and can optionally be pushed to any system through a generic, signed webhook.

## How "training per industry" works

There is no model fine-tuning. Each bot's behaviour is three layers combined at runtime:

| Layer | Owned by | Where | Contents |
|---|---|---|---|
| Industry template | vanibot | `apps/api/src/templates/index.ts` | Persona, safety rules, default lead fields, consent wording, suggested questions |
| Bot settings | The customer | Dashboard, Behaviour tab (`bots.config`) | Bot and company name, greeting, extra instructions, hours, lead fields, colours, voice |
| Knowledge | The customer | Dashboard, Knowledge tab (`documents`, `chunks`) | Uploaded PDF/DOCX/HTML/TXT, web pages, Q&A pairs; searched for every message |

Adding an industry means adding one template entry. Customers improve their bot through the "questions the bot couldn't answer" list on the Knowledge tab.

Templates today: General business, Medical bill discounts, Insurance, Loans and lending, Banking.

## Components

```
 Website visitor                 Phone caller                 Customer admin
 ┌──────────────┐               ┌─────────────┐              ┌───────────────┐
 │ widget.js    │ text + voice  │ Twilio      │ speech<->text│ Dashboard     │
 │ (shadow DOM) │ (Web Speech)  │ Voice       │              │ (React/Vite)  │
 └──────┬───────┘               └──────┬──────┘              └───────┬───────┘
        │ SSE stream                   │ TwiML webhooks              │ REST + JWT
 ┌──────▼──────────────────────────────▼─────────────────────────────▼───────┐
 │ API (Node, Fastify)                                                        │
 │  channels: web, web_voice, phone  ─┐                                       │
 │                                    ▼                                       │
 │  Orchestrator: frozen system prompt + tools per conversation,              │
 │  knowledge retrieved per message, Claude tool-use loop, streaming          │
 │  Tools: capture_lead, handoff_to_human                                     │
 │  Job worker: document ingestion, webhook delivery with retries             │
 │  Plans and usage limits, Stripe billing                                    │
 └──────┬───────────────────────┬───────────────────────┬────────────────────┘
        │                       │                       │
 ┌──────▼───────────┐   ┌───────▼────────┐      ┌───────▼────────┐
 │ Postgres 16      │   │ Claude API     │      │ Customer's own │
 │ + pgvector       │   │ (+ optional    │      │ webhook URL    │
 │ (all tenant data,│   │ Voyage AI for  │      │ (optional)     │
 │  job queue)      │   │ embeddings)    │      └────────────────┘
 └──────────────────┘   └────────────────┘
```

### Multi-tenancy
- One database; every tenant-owned table has `tenant_id`, and every query filters on it.
- Admin users authenticate with a JWT that carries their tenant. Widgets authenticate with the bot's public key plus an optional allowed-domains list.
- Later: Postgres row-level security, and dedicated databases for large customers.

### Conversations and the AI
- When a conversation starts, the system prompt (template + settings + channel style) and the tool list are built once and stored on the conversation. They never change mid-conversation, which keeps Claude's prompt cache warm and keeps earlier reasoning valid.
- For each visitor message, matching knowledge is retrieved (Postgres full-text search, plus vector search when a Voyage key is set) and placed in that user turn as a `<knowledge>` block.
- Claude's replies, including thinking and tool-call blocks, are stored exactly as received and replayed unchanged on the next turn.
- Model `claude-opus-5-5` at `low` effort by default (set `LLM_MODEL` / `LLM_EFFORT`). Server-side refusal fallback is on by default (`LLM_FALLBACKS`).

### Voice
- **Browser voice:** the widget's microphone button uses the browser's speech recognition and speech synthesis (Chrome, Edge, Safari). Hands-free: it listens again after speaking.
- **Phone:** a Twilio number points at `/v1/voice/twilio/incoming`. Twilio turns speech into text, vanibot replies, Twilio speaks it. Voice conversations get a "spoken style" prompt (short, no markdown) and the caller's number is attached to leads automatically. Call minutes are metered for billing.
- Later: realtime streaming voice (Twilio Media Streams with streaming speech-to-text and text-to-speech) for lower latency and barge-in; WhatsApp and SMS channels.

### Actions
| Tool | What it does |
|---|---|
| `capture_lead` | Validates the fields defined for the bot, requires explicit consent, saves the lead, sends `lead.created` to the webhook |
| `handoff_to_human` | Marks the conversation for follow-up and sends `handoff.requested` |

Webhooks are signed: `X-Vanibot-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)` with `X-Vanibot-Timestamp`. Failed deliveries retry with backoff (6 attempts).

Later: book a callback (calendar), check application/claim status (customer API), native CRM connectors (HubSpot, Salesforce, Zoho) as add-ons.

### Billing
Plans (placeholder prices, set real ones in Stripe): Trial (14 days), Starter, Growth, Business, limited by bots, conversations per month, phone voice minutes per month and documents. Stripe Checkout and the Customer Portal handle payment; a Stripe webhook keeps `tenants.plan` in sync.

## Compliance notes for regulated industries
- Medical billing: bill amount plus provider name next to a person's identity can be protected health information. Keep lead fields minimal, sign BAAs with vendors before collecting anything more, and set a retention period.
- Calls/SMS follow-up (US): the lead form records explicit consent text (TCPA).
- Lending/insurance/banking templates forbid approving loans, confirming coverage, or asking for account numbers.

## Roadmap after this MVP
1. Deploy (Docker images, managed Postgres, HTTPS domain, widget on a CDN)
2. Team members and roles per tenant; audit log
3. Realtime phone voice; WhatsApp/SMS channels
4. Analytics (resolution rate, lead conversion), conversation ratings
5. More actions and CRM connectors; multi-language templates
6. Row-level security, data retention settings, SOC 2 groundwork
