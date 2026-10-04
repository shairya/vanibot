import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one, pool, query, setScriptContext } from "../src/db.js";
import { startConversation, type BotRow } from "../src/core/conversations.js";
import { ingestDocument } from "../src/core/ingest.js";
import { runTurn } from "../src/core/orchestrator.js";
import { fakeClaude } from "./fakeClaude.js";

let tenantId: string;
let bot: BotRow;

beforeAll(async () => {
  setScriptContext({ system: true });
  tenantId = (await one("INSERT INTO tenants(name, plan) VALUES ('Test Co', 'pilot') RETURNING id")).id;
  setScriptContext({ tenantId }); // everything below runs as this company only
  bot = (await one(
    `INSERT INTO bots(tenant_id, name, industry, public_key, webhook_secret, webhook_url, config)
     VALUES ($1, 'Testbot', 'medical-bill-discount', $2, 'whsec_test', 'http://127.0.0.1:9/hook', '{"companyName":"Test Co"}')
     RETURNING id, tenant_id, name, industry, config, is_active, allowed_domains`,
    [tenantId, "pk_test_" + randomBytes(6).toString("hex")],
  ))!;
  const doc = await one("INSERT INTO documents(tenant_id, bot_id, kind, title, raw_text) VALUES ($1, $2, 'text', 'Fees', $3) RETURNING id", [
    tenantId,
    bot.id,
    "Our bill review is free. We charge 25 percent of the savings only if we lower your bill.",
  ]);
  await ingestDocument(doc.id);
});

afterAll(async () => {
  setScriptContext({ system: true });
  await query("DELETE FROM jobs WHERE tenant_id = $1", [tenantId]);
  await query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

async function collect(gen: AsyncGenerator<any>) {
  const events: any[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("runTurn", () => {
  it("answers with retrieved knowledge, streams text and persists the turn", async () => {
    const conv = await startConversation(bot, "web");
    const { client, requests } = fakeClaude([{ content: [{ type: "text", text: "The review is free; the fee is 25% of savings." }], stop_reason: "end_turn" }]);
    const events = await collect(runTurn(conv, "How much does your fee cost?", client));

    const streamed = events.filter((e) => e.type === "text").map((e) => e.text).join("");
    expect(streamed).toBe("The review is free; the fee is 25% of savings.");
    expect(events.at(-1)).toEqual({ type: "done", text: "The review is free; the fee is 25% of savings." });

    const req = requests[0];
    expect(req.system).toBe(conv.system_prompt);
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content[0].text).toContain("25 percent of the savings");
    expect(req.messages[0].content[1].text).toBe("How much does your fee cost?");

    const stored = await query("SELECT role, display_text FROM messages WHERE conversation_id = $1 ORDER BY id", [conv.id]);
    expect(stored).toEqual([
      { role: "user", display_text: "How much does your fee cost?" },
      { role: "assistant", display_text: "The review is free; the fee is 25% of savings." },
    ]);
  });

  it("replays earlier turns byte-for-byte, including thinking blocks", async () => {
    const conv = await startConversation(bot, "web");
    const thinking = { type: "thinking", thinking: "", signature: "sig_abc" };
    const first = fakeClaude([{ content: [thinking, { type: "text", text: "Hello!" }], stop_reason: "end_turn" }]);
    await collect(runTurn(conv, "hi", first.client));
    const second = fakeClaude([{ content: [{ type: "text", text: "Sure." }], stop_reason: "end_turn" }]);
    await collect(runTurn(conv, "can you help?", second.client));

    const replayed = second.requests[0].messages;
    expect(replayed).toHaveLength(3);
    expect(replayed[0]).toEqual(first.requests[0].messages[0]);
    expect(replayed[1]).toEqual({ role: "assistant", content: [thinking, { type: "text", text: "Hello!" }] });
    expect(second.requests[0].system).toBe(first.requests[0].system);
    expect(second.requests[0].tools).toEqual(first.requests[0].tools);
  });

  it("captures a lead through the tool loop and queues the webhook", async () => {
    const conv = await startConversation(bot, "web");
    const { client, requests } = fakeClaude([
      {
        content: [
          { type: "text", text: "Great, saving your details." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "capture_lead",
            input: { name: "Ana Diaz", phone: "+15551234567", bill_amount: "4200", consent: true, summary: "ER bill to review" },
          },
        ],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Done! Our team will call you soon." }], stop_reason: "end_turn" },
    ]);
    const events = await collect(runTurn(conv, "yes I agree, please call me", client));

    expect(events.some((e) => e.type === "tool" && e.event.type === "lead_captured")).toBe(true);
    const lead = await one("SELECT fields, consent FROM leads WHERE conversation_id = $1", [conv.id]);
    expect(lead.consent).toBe(true);
    expect(lead.fields).toMatchObject({ name: "Ana Diaz", phone: "+15551234567", bill_amount: 4200, summary: "ER bill to review" });

    const toolResultMsg = requests[1].messages.at(-1);
    expect(toolResultMsg.role).toBe("user");
    expect(toolResultMsg.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(toolResultMsg.content[0].is_error).toBeUndefined();

    const job = await one("SELECT payload FROM jobs WHERE tenant_id = $1 AND kind = 'deliver_webhook' ORDER BY id DESC LIMIT 1", [tenantId]);
    expect(job.payload.event).toBe("lead.created");
    expect(job.payload.data.fields.name).toBe("Ana Diaz");

    const roles = (await query("SELECT role FROM messages WHERE conversation_id = $1 ORDER BY id", [conv.id])).map((r) => r.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("rejects a lead without consent and tells Claude why", async () => {
    const conv = await startConversation(bot, "web");
    const { client, requests } = fakeClaude([
      {
        content: [{ type: "tool_use", id: "toolu_2", name: "capture_lead", input: { name: "Bo", phone: "+15550001111", consent: false, summary: "x" } }],
        stop_reason: "tool_use",
      },
      { content: [{ type: "text", text: "Do you agree to be contacted?" }], stop_reason: "end_turn" },
    ]);
    await collect(runTurn(conv, "call me", client));
    expect(await one("SELECT 1 FROM leads WHERE conversation_id = $1", [conv.id])).toBeUndefined();
    expect(requests[1].messages.at(-1).content[0].is_error).toBe(true);
  });

  it("does not persist a refused turn", async () => {
    const conv = await startConversation(bot, "web");
    const { client } = fakeClaude([{ content: [], stop_reason: "refusal" }]);
    const events = await collect(runTurn(conv, "something disallowed", client));
    expect(events.at(-1).type).toBe("done");
    expect(await query("SELECT 1 FROM messages WHERE conversation_id = $1", [conv.id])).toHaveLength(0);
  });

  it("uses spoken style and caller number on the phone channel", async () => {
    const conv = await startConversation(bot, "phone", { caller: "+15557654321" });
    expect(conv.system_prompt).toContain("spoken aloud");
    const leadTool = conv.tools.find((t) => t.name === "capture_lead")!;
    expect(leadTool.input_schema.required).not.toContain("phone");
    const { client } = fakeClaude([
      { content: [{ type: "tool_use", id: "toolu_3", name: "capture_lead", input: { name: "Cy", consent: true, summary: "bill" } }], stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Thanks, we'll call you." }], stop_reason: "end_turn" },
    ]);
    await collect(runTurn(conv, "yes", client));
    const lead = await one("SELECT fields FROM leads WHERE conversation_id = $1", [conv.id]);
    expect(lead.fields.phone).toBe("+15557654321");
  });
});
