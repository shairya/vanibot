// Creates a demo account with a medical-bill-discount bot and some sample knowledge.
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";
import { one, pool, query } from "./db.js";
import { ingestDocument } from "./core/ingest.js";

const email = "demo@vanibot.local";
const password = "demo12345";

const knowledge = `How our medical bill review works
1. You share your bill (or the hospital's name and the amount owed).
2. Our advocates check it for billing errors, duplicate charges and out-of-network surprises.
3. We negotiate directly with the hospital or provider for a lower amount or an affordable payment plan.
4. You approve any settlement before anything is paid.

What it costs
The review is free. If we reduce your bill, our fee is a share of the savings. If we don't save you money, you pay nothing.

Which bills qualify
Hospital, emergency room, surgery, lab, imaging and ambulance bills over $1,000 usually qualify, whether you are insured or uninsured. Bills already in collections can often still be negotiated.

How long it takes
Most reviews take 2 to 6 weeks, depending on how quickly the provider responds.

Privacy
We only use your information to work on your bill and we never sell it.

Contact
Phone support is available Monday to Friday, 9am to 6pm Eastern.`;

async function main() {
  let user = await one("SELECT id, tenant_id FROM users WHERE email = $1", [email]);
  if (!user) {
    const tenant = await one("INSERT INTO tenants(name, plan) VALUES ('Demo Bill Advocates', 'growth') RETURNING id");
    user = await one("INSERT INTO users(tenant_id, email, password_hash, name) VALUES ($1, $2, $3, 'Demo Admin') RETURNING id, tenant_id", [
      tenant.id,
      email,
      await hashPassword(password),
    ]);
  }
  let bot = await one("SELECT id, public_key FROM bots WHERE tenant_id = $1 LIMIT 1", [user.tenant_id]);
  if (!bot) {
    bot = await one(
      `INSERT INTO bots(tenant_id, name, industry, public_key, webhook_secret, config)
       VALUES ($1, 'Billie', 'medical-bill-discount', $2, $3, $4) RETURNING id, public_key`,
      [
        user.tenant_id,
        "pk_demo_" + randomBytes(8).toString("hex"),
        "whsec_" + randomBytes(24).toString("hex"),
        { botName: "Billie", companyName: "Demo Bill Advocates", businessHours: "Mon-Fri 9am-6pm Eastern" },
      ],
    );
    const doc = await one(
      "INSERT INTO documents(tenant_id, bot_id, kind, title, raw_text) VALUES ($1, $2, 'text', 'How bill review works', $3) RETURNING id",
      [user.tenant_id, bot.id, knowledge],
    );
    await ingestDocument(doc.id);
  }
  const chunks = await query("SELECT count(*)::int AS n FROM chunks WHERE bot_id = $1", [bot.id]);
  console.log(`
Demo account ready.
  Dashboard login:  ${email} / ${password}
  Bot public key:   ${bot.public_key}
  Knowledge chunks: ${chunks[0].n}
  Demo page:        ${(process.env.PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "")}/demo/${bot.public_key}
`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
