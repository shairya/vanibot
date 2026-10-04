// Local setup data: a vanibot team admin, the OXXY pilot company, and the demo bots shown on the website.
// Safe to run more than once.
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";
import { asSystem, one, pool, query, setScriptContext, withTenant } from "./db.js";
import { ingestDocument } from "./core/ingest.js";
import { getPlan } from "./core/plans.js";

const publicUrl = (process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "");

type BotSeed = { publicKey: string; name: string; industry: string; config: Record<string, unknown>; knowledge: { title: string; text: string }[] };

async function ensureTenant(name: string, plan: string) {
  const existing = await one("SELECT id FROM tenants WHERE name = $1", [name]);
  if (existing) return existing.id as string;
  return (await one("INSERT INTO tenants(name, plan, channels) VALUES ($1, $2, $3) RETURNING id", [name, plan, getPlan(plan).channels])).id as string;
}

async function ensureUser(tenantId: string, email: string, password: string, name: string, platformAdmin = false) {
  const existing = await one("SELECT id FROM users WHERE email = $1", [email]);
  if (existing) return;
  await query("INSERT INTO users(tenant_id, email, password_hash, name, is_platform_admin) VALUES ($1, $2, $3, $4, $5)", [
    tenantId,
    email,
    await hashPassword(password),
    name,
    platformAdmin,
  ]);
}

async function ensureBot(tenantId: string, b: BotSeed) {
  return withTenant(tenantId, async () => {
    let bot = await one("SELECT id FROM bots WHERE public_key = $1", [b.publicKey]);
    if (bot) return b.publicKey;
    bot = await one(
      "INSERT INTO bots(tenant_id, name, industry, public_key, webhook_secret, config) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [tenantId, b.name, b.industry, b.publicKey, "whsec_" + randomBytes(24).toString("hex"), b.config],
    );
    for (const k of b.knowledge) {
      const doc = await one("INSERT INTO documents(tenant_id, bot_id, kind, title, raw_text) VALUES ($1, $2, 'text', $3, $4) RETURNING id", [
        tenantId,
        bot.id,
        k.title,
        k.text,
      ]);
      await ingestDocument(doc.id);
    }
    return b.publicKey;
  });
}

// ---------- OXXY (pilot) ----------
// PLACEHOLDER knowledge: replace it with OXXY's real documents from the dashboard before going live.
const oxxyKnowledge = `SAMPLE CONTENT - replace with OXXY's own documents before going live.

How OXXY helps with medical bills
OXXY helps patients and families lower their hospital and medical bills. Share your bill or estimate, and the team checks it and works on getting you a discount.

How it works
1. Share your hospital bill or estimate (a photo or PDF is fine).
2. The OXXY team reviews it and tells you what discount may be possible.
3. You decide whether to go ahead.

Contact
The OXXY team will call you back after you share your details.`;

// ---------- Website demo bots (fictional companies) ----------
const demoBots: BotSeed[] = [
  {
    publicKey: "pk_demo_medical",
    name: "Asha",
    industry: "medical-bill-discount",
    config: { botName: "Asha", companyName: "MediSave", theme: { color: "#0f766e" }, businessHours: "Mon-Sat 9am-7pm IST", defaultLanguage: "en-IN" },
    knowledge: [
      {
        title: "How MediSave works",
        text: `MediSave is a fictional company used to demonstrate vanibot.
How it works: share your hospital bill, our team checks it for errors and negotiates a discount with the hospital, and you approve before paying.
Cost: the review is free. If we lower your bill, our fee is 20 percent of the amount saved. If we save nothing, you pay nothing.
Which bills: hospital stays, surgeries, diagnostics and day-care procedures above Rs 25,000 usually qualify, with or without health insurance.
Time: most reviews take 1 to 3 weeks.
Languages: you can talk to us in English, Hindi, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, Punjabi or Odia.`,
      },
    ],
  },
  {
    publicKey: "pk_demo_insurance",
    name: "Kavya",
    industry: "insurance",
    config: { botName: "Kavya", companyName: "SurakshaCover", theme: { color: "#0f766e" }, businessHours: "Mon-Sat 9am-6pm IST" },
    knowledge: [
      {
        title: "SurakshaCover plans",
        text: `SurakshaCover is a fictional insurance distributor used to demonstrate vanibot.
Health plans: individual and family floater cover from Rs 5 lakh to Rs 1 crore, cashless treatment at network hospitals.
Term life: cover for 10 to 40 years.
Motor: car and two-wheeler insurance with renewal reminders.
Claims: call the claims helpline or use the app; keep your policy number and hospital documents ready.
Quotes depend on age, city and medical history; a licensed advisor confirms the final premium.`,
      },
    ],
  },
  {
    publicKey: "pk_demo_lending",
    name: "Arjun",
    industry: "lending",
    config: { botName: "Arjun", companyName: "QuickRupee Finance", theme: { color: "#0f766e" }, businessHours: "Mon-Sat 10am-7pm IST" },
    knowledge: [
      {
        title: "QuickRupee loans",
        text: `QuickRupee Finance is a fictional lender used to demonstrate vanibot.
Personal loans: Rs 50,000 to Rs 15 lakh, 12 to 60 months, interest from 11.5 percent per year.
Business loans: up to Rs 50 lakh for businesses older than 2 years.
Documents: identity proof, address proof, last 6 months of bank statements, salary slips or ITR.
Final rate and approval depend on a full application and credit check.`,
      },
    ],
  },
];

async function main() {
  setScriptContext({ system: true });

  const hq = await ensureTenant("vanibot HQ", "pilot");
  await ensureUser(hq, "admin@vanibot.local", "admin12345", "vanibot Admin", true);

  const oxxy = await ensureTenant("OXXY", "pilot");
  await ensureUser(oxxy, "oxxy@vanibot.local", "oxxy12345", "OXXY Admin");
  const oxxyKey = await ensureBot(oxxy, {
    publicKey: "pk_oxxy_pilot",
    name: "OXXY Assistant",
    industry: "medical-bill-discount",
    config: { botName: "OXXY Assistant", companyName: "OXXY", defaultLanguage: "en-IN" },
    knowledge: [{ title: "SAMPLE - replace with OXXY documents", text: oxxyKnowledge }],
  });

  const demo = await ensureTenant("vanibot Demos", "pilot");
  for (const b of demoBots) await ensureBot(demo, b);

  const counts = await asSystem(() => query("SELECT t.name, count(c.id)::int AS chunks FROM tenants t LEFT JOIN chunks c ON c.tenant_id = t.id GROUP BY t.name ORDER BY t.name"));
  console.log(`
vanibot local data ready.

  vanibot team login:  admin@vanibot.local / admin12345   (sees every company)
  OXXY login:          oxxy@vanibot.local / oxxy12345
  OXXY demo page:      ${publicUrl}/demo/${oxxyKey}
  Website demo bots:   ${demoBots.map((b) => `${publicUrl}/demo/${b.publicKey}`).join("\n                       ")}

  Knowledge chunks per company: ${counts.map((c) => `${c.name}=${c.chunks}`).join(", ")}
  Note: OXXY's knowledge is SAMPLE text. Replace it with OXXY's own documents in the dashboard.
`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
