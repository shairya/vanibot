import { useEffect, useState } from "react";
import { api } from "./api";
import { useLoad } from "./pages";

type Tab = "setup" | "knowledge" | "channels" | "whatsapp" | "install" | "voice";

export function BotPage({ id, me }: { id: string; me: any }) {
  const bot = useLoad<any>(`/api/bots/${id}`, [id]);
  const [tab, setTab] = useState<Tab>("setup");
  if (bot.error) return <div className="error">{bot.error}</div>;
  if (!bot.data) return <p>Loading...</p>;
  const b = bot.data;
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{b.name}</h1>
        <div className="row">
          <a href={b.demoUrl} target="_blank" rel="noreferrer"><button className="secondary">Try it on a demo page</button></a>
        </div>
      </div>
      <div className="tabs">
        {(
          [
            ["setup", "Behaviour"],
            ["knowledge", "Knowledge"],
            ["channels", "Channels & language"],
            ["whatsapp", "WhatsApp"],
            ["install", "Website & leads"],
            ...(me.features.phone ? [["voice", "Phone calls"]] : []),
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>
      {tab === "setup" && <SetupTab bot={b} onSaved={bot.reload} />}
      {tab === "knowledge" && <KnowledgeTab botId={id} />}
      {tab === "channels" && <ChannelsTab bot={b} me={me} onSaved={bot.reload} />}
      {tab === "whatsapp" && <WhatsAppTab bot={b} me={me} onSaved={bot.reload} />}
      {tab === "install" && <InstallTab bot={b} onSaved={bot.reload} />}
      {tab === "voice" && <VoiceTab bot={b} onSaved={bot.reload} />}
    </>
  );
}

function useSaver(id: string, onSaved: () => void) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(body: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/bots/${id}`, { method: "PATCH", body });
      setMsg({ ok: true, text: "Saved. New conversations use these settings." });
      onSaved();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  const view = msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>;
  return { save, busy, view };
}

function SetupTab({ bot, onSaved }: { bot: any; onSaved: () => void }) {
  const templates = useLoad<any[]>("/api/templates");
  const r = bot.resolved;
  const [s, setS] = useState({
    name: bot.name,
    industry: bot.industry,
    botName: r.botName,
    companyName: r.companyName,
    greeting: bot.config.greeting ?? "",
    extraInstructions: r.extraInstructions,
    businessHours: r.businessHours,
    contactInfo: r.contactInfo,
    suggestedQuestions: r.suggestedQuestions.join("\n"),
    color: r.theme.color,
    position: r.theme.position,
    captureLead: r.actions.captureLead,
    handoff: r.actions.handoff,
    leadFields: JSON.stringify(bot.config.leadFields ?? r.leadFields, null, 2),
    customLeadFields: Boolean(bot.config.leadFields),
    is_active: bot.is_active,
  });
  const { save, busy, view } = useSaver(bot.id, onSaved);
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const [fieldsError, setFieldsError] = useState("");

  function submit() {
    let leadFields: unknown = undefined;
    if (s.customLeadFields) {
      try {
        leadFields = JSON.parse(s.leadFields);
        setFieldsError("");
      } catch {
        return setFieldsError("Lead fields must be valid JSON.");
      }
    }
    void save({
      name: s.name,
      industry: s.industry,
      is_active: s.is_active,
      config: {
        ...bot.config,
        botName: s.botName,
        companyName: s.companyName,
        greeting: s.greeting || undefined,
        extraInstructions: s.extraInstructions,
        businessHours: s.businessHours,
        contactInfo: s.contactInfo,
        suggestedQuestions: s.suggestedQuestions.split("\n").map((q: string) => q.trim()).filter(Boolean).slice(0, 6),
        theme: { color: s.color, position: s.position },
        actions: { captureLead: s.captureLead, handoff: s.handoff },
        leadFields,
      },
    });
  }

  return (
    <>
      <div className="card">
        <h2>Identity</h2>
        <div className="grid2">
          <div><label>Internal name</label><input value={s.name} onChange={(e) => set("name", e.target.value)} /></div>
          <div>
            <label>Industry template</label>
            <select value={s.industry} onChange={(e) => set("industry", e.target.value)}>
              {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div className="hint">Sets the bot's persona, safety rules and default lead fields for this industry.</div>
          </div>
          <div><label>Bot name shown to visitors</label><input value={s.botName} onChange={(e) => set("botName", e.target.value)} /></div>
          <div><label>Company name</label><input value={s.companyName} onChange={(e) => set("companyName", e.target.value)} /></div>
        </div>
        <p><label>Greeting</label><input value={s.greeting} placeholder={r.greeting} onChange={(e) => set("greeting", e.target.value)} />
          <span className="hint">Leave empty to use the template's greeting.</span></p>
        <p><label>Suggested questions (one per line)</label><textarea value={s.suggestedQuestions} onChange={(e) => set("suggestedQuestions", e.target.value)} /></p>
      </div>
      <div className="card">
        <h2>Training</h2>
        <p><label>Extra instructions</label>
          <textarea value={s.extraInstructions} onChange={(e) => set("extraInstructions", e.target.value)}
            placeholder="e.g. Always mention our 30-day guarantee. Never discuss competitors. Reply in Spanish if the visitor writes in Spanish." />
          <span className="hint">Added on top of the industry template. Facts belong in Knowledge; rules and tone belong here.</span></p>
        <div className="grid2">
          <div><label>Business hours</label><input value={s.businessHours} onChange={(e) => set("businessHours", e.target.value)} /></div>
          <div><label>Contact details the bot may share</label><input value={s.contactInfo} onChange={(e) => set("contactInfo", e.target.value)} /></div>
        </div>
      </div>
      <div className="card">
        <h2>Actions</h2>
        <p><label><input type="checkbox" checked={s.captureLead} onChange={(e) => set("captureLead", e.target.checked)} /> Capture leads</label></p>
        <p><label><input type="checkbox" checked={s.handoff} onChange={(e) => set("handoff", e.target.checked)} /> Hand off to a human when asked</label></p>
        <p><label><input type="checkbox" checked={s.customLeadFields} onChange={(e) => set("customLeadFields", e.target.checked)} /> Customise lead fields</label></p>
        {s.customLeadFields && (
          <>
            <textarea style={{ minHeight: 220, fontFamily: "monospace" }} value={s.leadFields} onChange={(e) => set("leadFields", e.target.value)} />
            <div className="hint">Each field: key (lowercase_with_underscores), label, type (text, email, phone, number), required (true/false).</div>
            {fieldsError && <div className="error">{fieldsError}</div>}
          </>
        )}
      </div>
      <div className="card">
        <h2>Look</h2>
        <div className="grid2">
          <div><label>Brand colour</label><input type="color" value={s.color} onChange={(e) => set("color", e.target.value)} style={{ height: 40 }} /></div>
          <div><label>Position</label>
            <select value={s.position} onChange={(e) => set("position", e.target.value)}><option value="right">Bottom right</option><option value="left">Bottom left</option></select></div>
        </div>
        <p><label><input type="checkbox" checked={s.is_active} onChange={(e) => set("is_active", e.target.checked)} /> Bot is live</label></p>
      </div>
      {view}
      <button onClick={submit} disabled={busy}>Save changes</button>
    </>
  );
}

function KnowledgeTab({ botId }: { botId: string }) {
  const docs = useLoad<any[]>(`/api/bots/${botId}/documents`);
  const unanswered = useLoad<any[]>(`/api/bots/${botId}/unanswered`);
  const [url, setUrl] = useState("");
  const [qa, setQa] = useState({ title: "", text: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Refresh while documents are being processed.
  useEffect(() => {
    if (!docs.data?.some((d) => d.status === "pending" || d.status === "processing")) return;
    const t = setTimeout(docs.reload, 2000);
    return () => clearTimeout(t);
  }, [docs.data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      docs.reload();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  }

  return (
    <>
      <div className="card">
        <h2>Add knowledge</h2>
        <p className="muted">The bot answers only from what you add here. Upload FAQs, policies, price sheets, brochures or web pages.</p>
        <div className="grid2">
          <div>
            <label>Upload a file (PDF, DOCX, HTML, TXT, MD, CSV)</label>
            <input type="file" accept=".pdf,.docx,.html,.htm,.txt,.md,.csv" onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.append("file", file);
              void run(() => api(`/api/bots/${botId}/documents/upload`, { form }), `${file.name} uploaded.`);
              e.target.value = "";
            }} />
          </div>
          <div>
            <label>Add a web page</label>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/faq" />
              <button onClick={() => run(() => api(`/api/bots/${botId}/documents/url`, { body: { url } }).then(() => setUrl("")), "Page added.")} disabled={!url}>Add</button>
            </div>
          </div>
        </div>
        <p><label>Or write a question and answer</label>
          <input placeholder="Question, e.g. Do you work with uninsured patients?" value={qa.title} onChange={(e) => setQa({ ...qa, title: e.target.value })} /></p>
        <textarea placeholder="Answer" value={qa.text} onChange={(e) => setQa({ ...qa, text: e.target.value })} />
        <p><button disabled={!qa.title || !qa.text} onClick={() =>
          run(() => api(`/api/bots/${botId}/documents/text`, { body: { kind: "qa", title: qa.title, text: `Q: ${qa.title}\nA: ${qa.text}` } }).then(() => setQa({ title: "", text: "" })), "Answer added.")}>Add answer</button></p>
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      </div>
      <div className="card">
        <h2>Documents</h2>
        {!docs.data?.length ? <p className="muted">Nothing added yet.</p> : (
          <table>
            <thead><tr><th>Title</th><th>Type</th><th>Status</th><th>Sections</th><th /></tr></thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}{d.error && <div className="error">{d.error}</div>}</td>
                  <td>{d.kind}</td>
                  <td><span className={`badge ${d.status}`}>{d.status}</span></td>
                  <td>{d.chunk_count}</td>
                  <td><button className="danger" onClick={() => run(() => api(`/api/documents/${d.id}`, { method: "DELETE" }), "Removed.")}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Questions the bot couldn't find answers for</h2>
        <p className="muted">Add answers for these to make the bot smarter.</p>
        {!unanswered.data?.length ? <p className="muted">None yet.</p> : (
          <ul>{unanswered.data.map((u, i) => <li key={i}>{u.question} <span className="muted">({new Date(u.created_at).toLocaleDateString()})</span></li>)}</ul>
        )}
      </div>
    </>
  );
}

function InstallTab({ bot, onSaved }: { bot: any; onSaved: () => void }) {
  const [domains, setDomains] = useState((bot.allowed_domains ?? []).join("\n"));
  const [webhook, setWebhook] = useState(bot.webhook_url ?? "");
  const [test, setTest] = useState<string>("");
  const { save, busy, view } = useSaver(bot.id, onSaved);
  return (
    <>
      <div className="card">
        <h2>Add the bot to your website</h2>
        <p>Paste this just before <code>&lt;/body&gt;</code> on every page where the bot should appear:</p>
        <pre>{bot.embedSnippet}</pre>
        <button className="secondary" onClick={() => navigator.clipboard.writeText(bot.embedSnippet)}>Copy</button>
      </div>
      <div className="card">
        <h2>Allowed websites</h2>
        <label>Domains (one per line)</label>
        <textarea value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={"example.com\nshop.example.com"} />
        <div className="hint">Leave empty while testing. Once set, the bot only works on these domains and their subdomains.</div>
      </div>
      <div className="card">
        <h2>Send leads to your own system (optional)</h2>
        <p className="muted">Leads always appear on the Leads page. If you also want them pushed to your CRM or another system, enter a URL and vanibot will POST each new lead to it as JSON.</p>
        <label>Webhook URL</label>
        <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://your-system.example.com/vanibot-leads" />
        <p className="hint">Events: <code>lead.created</code>, <code>handoff.requested</code>. Verify requests with the <code>X-Vanibot-Signature</code> header: HMAC-SHA256 of <code>timestamp + "." + body</code> using this secret:</p>
        <pre>{bot.webhook_secret}</pre>
        <button className="secondary" disabled={!bot.webhook_url} onClick={async () => {
          const r = await api(`/api/bots/${bot.id}/test-webhook`, { body: {} });
          setTest(r.ok ? `Test lead delivered (HTTP ${r.status}).` : `Delivery failed: ${r.error ?? `HTTP ${r.status}`}`);
        }}>Send a test lead</button>
        {test && <p>{test}</p>}
      </div>
      {view}
      <button disabled={busy} onClick={() => save({ allowed_domains: domains.split("\n").map((d: string) => d.trim()).filter(Boolean), webhook_url: webhook.trim() })}>Save changes</button>
    </>
  );
}

function VoiceTab({ bot, onSaved }: { bot: any; onSaved: () => void }) {
  const r = bot.resolved;
  const [s, setS] = useState({ enabled: r.voice.enabled, lang: r.voice.lang, phoneVoice: r.voice.phoneVoice, phone: bot.phone_number ?? "" });
  const { save, busy, view } = useSaver(bot.id, onSaved);
  return (
    <>
      <div className="card">
        <h2>Voice</h2>
        <p><label><input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> Enable voice (microphone in the website widget and phone calls)</label></p>
        <div className="grid2">
          <div><label>Language</label><input value={s.lang} onChange={(e) => setS({ ...s, lang: e.target.value })} /><div className="hint">e.g. en-IN, hi-IN, ta-IN</div></div>
          <div><label>Phone voice</label><input value={s.phoneVoice} onChange={(e) => setS({ ...s, phoneVoice: e.target.value })} /><div className="hint">A Twilio voice name, e.g. Polly.Aditi or Google.hi-IN-Neural2-A</div></div>
        </div>
      </div>
      <div className="card">
        <h2>Phone number</h2>
        <p className="muted">Callers to this number talk to the bot. Buy a number in Twilio, then point it at vanibot:</p>
        <ol>
          <li>In the Twilio console open Phone Numbers, then your number.</li>
          <li>Under Voice Configuration set "A call comes in" to Webhook, HTTP POST, <code>{bot.voiceWebhookUrl}</code></li>
          <li>Set the "Call status changes" callback to <code>{bot.voiceWebhookUrl.replace("incoming", "status")}</code></li>
          <li>Enter the same number below in +countrycode format and save.</li>
        </ol>
        <label>Twilio phone number</label>
        <input value={s.phone} onChange={(e) => setS({ ...s, phone: e.target.value })} placeholder="+15551234567" />
      </div>
      {view}
      <button disabled={busy} onClick={() => save({ phone_number: s.phone.trim(), config: { ...bot.config, voice: { enabled: s.enabled, lang: s.lang, phoneVoice: s.phoneVoice } } })}>Save changes</button>
    </>
  );
}

const LANGUAGES: [string, string][] = [
  ["en-IN", "English"], ["hi-IN", "Hindi"], ["bn-IN", "Bengali"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"], ["mr-IN", "Marathi"],
  ["gu-IN", "Gujarati"], ["kn-IN", "Kannada"], ["ml-IN", "Malayalam"], ["pa-IN", "Punjabi"], ["od-IN", "Odia"],
];

function ChannelsTab({ bot, me, onSaved }: { bot: any; me: any; onSaved: () => void }) {
  const r = bot.resolved;
  const [ch, setCh] = useState<Record<"web" | "whatsapp" | "voice", boolean>>({ ...r.channels });
  const [lang, setLang] = useState(r.defaultLanguage);
  const [speaker, setSpeaker] = useState(r.voice.speaker);
  const { save, busy, view } = useSaver(bot.id, onSaved);
  const bought: string[] = me.tenant.channels;
  const rows: ["web" | "whatsapp" | "voice", string, string][] = [
    ["web", "Website chat", "The chat bubble on your website."],
    ["whatsapp", "WhatsApp chat", "Customers message your WhatsApp Business number and get typed replies."],
    ["voice", "Voice", "Customers can send WhatsApp voice notes (the bot replies with a voice note and text) and talk to the website bubble."],
  ];
  return (
    <>
      <div className="card">
        <h2>Channels for this bot</h2>
        {rows.map(([key, label, help]) => {
          const allowed = bought.includes(key);
          return (
            <label className="switch" key={key} style={{ fontWeight: 400 }}>
              <input type="checkbox" disabled={!allowed} checked={allowed && ch[key]} onChange={(e) => setCh({ ...ch, [key]: e.target.checked })} />
              <span>
                <b>{label}</b>
                <div className="hint">{allowed ? help : "Not included in your plan. Contact the vanibot team to add it."}</div>
              </span>
            </label>
          );
        })}
      </div>
      <div className="card">
        <h2>Language</h2>
        <div className="grid2">
          <div>
            <label>Default language</label>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
            <div className="hint">The bot always replies in the customer's language (including Hinglish). This is used when it can't tell.</div>
          </div>
          <div>
            <label>Voice for spoken replies</label>
            <input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Server default" />
            <div className="hint">A Sarvam voice name, e.g. anushka or abhilash. Leave empty for the default.</div>
          </div>
        </div>
      </div>
      {view}
      <button disabled={busy} onClick={() => save({ config: { ...bot.config, channels: ch, defaultLanguage: lang, voice: { ...(bot.config.voice ?? {}), speaker: speaker.trim() } } })}>
        Save changes
      </button>
    </>
  );
}

function WhatsAppTab({ bot, me, onSaved }: { bot: any; me: any; onSaved: () => void }) {
  const [s, setS] = useState({
    phoneNumberId: bot.whatsapp_phone_number_id ?? "",
    display: bot.whatsapp_display_number ?? "",
    waba: bot.whatsapp_business_account_id ?? "",
    token: "",
  });
  const { save, busy, view } = useSaver(bot.id, onSaved);
  const set = (k: keyof typeof s) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value });
  const included = me.tenant.channels.includes("whatsapp") || me.tenant.channels.includes("voice");
  return (
    <>
      {!included && <div className="card muted">WhatsApp is not included in your plan. Contact the vanibot team to add it.</div>}
      <div className="card">
        <h2>Connect your WhatsApp Business number</h2>
        <p className="muted">vanibot uses Meta's official WhatsApp Cloud API. You need a Meta Business account and a phone number that is not already on the WhatsApp app.</p>
        <ol className="steps">
          <li>In Meta for Developers, open the vanibot app's WhatsApp setup (the vanibot team adds your number), or your own app if you have one.</li>
          <li>Webhook callback URL: <code>{me.features.whatsappWebhookUrl}</code> with the verify token from the vanibot team. Subscribe to <b>messages</b>.</li>
          <li>Copy the <b>Phone number ID</b> and <b>WhatsApp Business Account ID</b> from the API setup page into the fields below.</li>
          <li>Create a permanent access token (a System User token with whatsapp_business_messaging permission) and paste it below.</li>
        </ol>
        <div className="grid2">
          <div><label>Phone number ID</label><input value={s.phoneNumberId} onChange={set("phoneNumberId")} placeholder="e.g. 106540352242922" /></div>
          <div><label>WhatsApp number (shown to your team)</label><input value={s.display} onChange={set("display")} placeholder="+91 98xxx xxxxx" /></div>
          <div><label>WhatsApp Business Account ID</label><input value={s.waba} onChange={set("waba")} placeholder="e.g. 102290129340398" /></div>
          <div>
            <label>Access token</label>
            <input type="password" value={s.token} onChange={set("token")} placeholder={bot.whatsapp_token_set ? "Saved. Paste a new one to replace it" : "Paste the token"} />
            <div className="hint">Stored encrypted and never shown again. Without a token, replies are only written to the server log (test mode).</div>
          </div>
        </div>
      </div>
      {view}
      <button
        disabled={busy}
        onClick={() =>
          save({
            whatsapp_phone_number_id: s.phoneNumberId.trim(),
            whatsapp_display_number: s.display.trim(),
            whatsapp_business_account_id: s.waba.trim(),
            ...(s.token.trim() ? { whatsapp_access_token: s.token.trim() } : {}),
          })
        }
      >
        Save changes
      </button>
    </>
  );
}
