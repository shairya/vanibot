import { useEffect, useState } from "react";
import { api, downloadLeadsCsv } from "./api";

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    api<T>(path).then(setData).catch((e) => setError(e.message));
  }, [path, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

const fmt = (d: string) => new Date(d).toLocaleString();

export function BotsPage({ me }: { me: any }) {
  const bots = useLoad<any[]>("/api/bots");
  const templates = useLoad<any[]>("/api/templates");
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("generic");
  const [error, setError] = useState("");

  async function create() {
    setError("");
    try {
      const { id } = await api("/api/bots", { body: { name, industry } });
      location.hash = `#/bots/${id}`;
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <>
      <h1>Your bots</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card" style={{ flex: 1, marginBottom: 0 }}>
          <div className="muted">Conversations this month</div>
          <div className="stat">{me.usage.conversations} <span className="muted" style={{ fontSize: 14 }}>/ {me.plan.conversationsPerMonth}</span></div>
        </div>
        <div className="card" style={{ flex: 1, marginBottom: 0 }}>
          <div className="muted">Voice minutes this month</div>
          <div className="stat">{me.usage.voiceMinutes} <span className="muted" style={{ fontSize: 14 }}>/ {me.plan.voiceMinutesPerMonth}</span></div>
        </div>
        <div className="card" style={{ flex: 1, marginBottom: 0 }}>
          <div className="muted">Plan</div>
          <div className="stat">{me.plan.name}</div>
        </div>
      </div>
      <div className="card">
        {bots.data?.length ? (
          <table>
            <thead><tr><th>Name</th><th>Industry</th><th>Documents</th><th>Conversations</th><th>Leads</th><th>Status</th></tr></thead>
            <tbody>
              {bots.data.map((b) => (
                <tr key={b.id}>
                  <td><a href={`#/bots/${b.id}`}>{b.name}</a></td>
                  <td>{templates.data?.find((t) => t.id === b.industry)?.name ?? b.industry}</td>
                  <td>{b.documents}</td><td>{b.conversations}</td><td>{b.leads}</td>
                  <td><span className={`badge ${b.is_active ? "active" : ""}`}>{b.is_active ? "Live" : "Paused"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No bots yet. Create your first one below.</p>
        )}
      </div>
      <div className="card">
        <h2>Create a bot</h2>
        <div className="grid2">
          <div><label>Bot or company name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Billing Help" /></div>
          <div>
            <label>Industry template</label>
            <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
              {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div className="hint">{templates.data?.find((t) => t.id === industry)?.description}</div>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <p><button onClick={create} disabled={!name.trim()}>Create bot</button></p>
      </div>
    </>
  );
}

export function LeadsPage() {
  const leads = useLoad<any[]>("/api/leads");
  async function setStatus(id: string, status: string) {
    await api(`/api/leads/${id}`, { method: "PATCH", body: { status } });
    leads.reload();
  }
  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Leads</h1>
        <button className="secondary" onClick={downloadLeadsCsv}>Export CSV</button>
      </div>
      <div className="card">
        {!leads.data?.length ? (
          <p className="muted">No leads yet. They appear here as soon as a visitor shares their details with a bot.</p>
        ) : (
          <table>
            <thead><tr><th>When</th><th>Details</th><th>Bot</th><th>Channel</th><th>Status</th></tr></thead>
            <tbody>
              {leads.data.map((l) => (
                <tr key={l.id}>
                  <td>{fmt(l.created_at)}</td>
                  <td>
                    {Object.entries(l.fields).map(([k, v]) => (
                      <div key={k}><span className="muted">{k.replace(/_/g, " ")}:</span> {String(v)}</div>
                    ))}
                    {l.conversation_id && <a href={`#/conversations?id=${l.conversation_id}`}>View conversation</a>}
                  </td>
                  <td>{l.bot_name}</td>
                  <td>{l.channel ?? "-"}</td>
                  <td>
                    <select value={l.status} onChange={(e) => setStatus(l.id, e.target.value)}>
                      {["new", "contacted", "qualified", "closed"].map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

export function ConversationsPage() {
  const list = useLoad<any[]>("/api/conversations");
  const initial = new URLSearchParams(location.hash.split("?")[1] ?? "").get("id");
  const [selected, setSelected] = useState<string | null>(initial);
  const detail = useLoad<any>(selected ? `/api/conversations/${selected}` : null);
  return (
    <>
      <h1>Conversations</h1>
      <div className="grid2">
        <div className="card">
          {!list.data?.length && <p className="muted">No conversations yet.</p>}
          <table>
            <tbody>
              {list.data?.map((c) => (
                <tr key={c.id} onClick={() => setSelected(c.id)} style={{ cursor: "pointer", background: c.id === selected ? "#eef2ff" : undefined }}>
                  <td>
                    <div>{c.first_message ?? <span className="muted">(no messages)</span>}</div>
                    <div className="muted">{c.bot_name} · {c.channel}{c.caller ? ` · ${c.caller}` : ""} · {fmt(c.updated_at)}</div>
                  </td>
                  <td>{c.status !== "open" && <span className={`badge ${c.status}`}>{c.status}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card transcript">
          {!detail.data ? (
            <p className="muted">Select a conversation to read it.</p>
          ) : (
            detail.data.messages.map((m: any, i: number) => (
              <div key={i} className={m.role === "user" ? "u" : ""}>
                <strong>{m.role === "user" ? "Visitor" : "Bot"}:</strong> {m.text}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

export function BillingPage({ me }: { me: any }) {
  const [error, setError] = useState("");
  const status = new URLSearchParams(location.hash.split("?")[1] ?? "").get("status");
  async function go(path: string, body?: unknown) {
    setError("");
    try {
      const { url } = await api(path, { body: body ?? {} });
      location.href = url;
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <>
      <h1>Plan & billing</h1>
      {status === "success" && <div className="success">Thanks! Your subscription is active. It can take a few seconds to show here.</div>}
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <div className="muted">Current plan</div>
            <div className="stat">{me.plan.name}</div>
            {me.tenant.plan === "trial" && <div className="muted">Trial ends {new Date(me.tenant.trial_ends_at).toLocaleDateString()}</div>}
          </div>
          {me.tenant.hasBilling && <button className="secondary" onClick={() => go("/api/billing/portal")}>Manage billing</button>}
        </div>
        <p className="muted">
          This month: {me.usage.conversations} conversations, {me.usage.voiceMinutes} voice minutes,{" "}
          {(me.usage.inputTokens + me.usage.outputTokens).toLocaleString()} AI tokens.
        </p>
      </div>
      {!me.billingEnabled && <div className="card muted">Billing isn't configured on this server yet (add the Stripe keys to .env).</div>}
      {error && <div className="error">{error}</div>}
      <div className="plans">
        {me.plans.map((p: any) => (
          <div className="card" key={p.id}>
            <h2>{p.name}</h2>
            <div className="stat">{p.priceLabel}</div>
            <ul>
              <li>{p.bots} bot{p.bots > 1 ? "s" : ""}</li>
              <li>{p.conversationsPerMonth.toLocaleString()} conversations / month</li>
              <li>{p.voiceMinutesPerMonth.toLocaleString()} phone voice minutes / month</li>
              <li>{p.documents} knowledge documents</li>
              <li>{p.removeBranding ? "No vanibot branding" : "vanibot branding"}</li>
            </ul>
            <button disabled={!me.billingEnabled || me.tenant.plan === p.id} onClick={() => go("/api/billing/checkout", { plan: p.id })}>
              {me.tenant.plan === p.id ? "Current plan" : "Choose"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
