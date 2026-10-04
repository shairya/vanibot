import { useEffect, useState, type FormEvent } from "react";
import { api, getActAs, getToken, setActAs, setToken } from "./api";
import { BotPage } from "./BotPage";
import { BotsPage, ConversationsPage, LeadsPage, PlanPage, TeamPage } from "./pages";

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "").split("?")[0];
}

export function App() {
  const route = useHashRoute();
  const [me, setMe] = useState<any>(null);
  const [authed, setAuthed] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!authed) return;
    api("/api/me")
      .then(setMe)
      .catch(() => {
        if (getActAs()) {
          setActAs(null); // the company we were acting for is gone; fall back to our own
          return api("/api/me").then(setMe);
        }
        setAuthed(false);
      })
      .catch(() => setAuthed(false));
  }, [authed, route]);

  if (!authed) return <AuthPage onDone={() => setAuthed(true)} />;
  if (!me) return <main>Loading...</main>;

  const nav = [
    ["#/", "Bots"],
    ["#/leads", "Leads"],
    ["#/conversations", "Conversations"],
    ["#/plan", "Plan & usage"],
    ...(me.user.is_platform_admin ? [["#/team", "vanibot team"]] : []),
  ];
  const botMatch = route.match(/^\/bots\/([0-9a-f-]+)/);
  let page;
  if (botMatch) page = <BotPage id={botMatch[1]} me={me} />;
  else if (route === "/leads") page = <LeadsPage />;
  else if (route === "/conversations") page = <ConversationsPage />;
  else if (route === "/plan") page = <PlanPage me={me} />;
  else if (route === "/team" && me.user.is_platform_admin) page = <TeamPage me={me} />;
  else page = <BotsPage me={me} />;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="logo">vanibot</div>
        {nav.map(([href, label]) => (
          <a key={href} href={href} className={("#" + route === href || (href === "#/" && botMatch)) ? "active" : ""}>
            {label}
          </a>
        ))}
        <div className="spacer" />
        <div className="who">
          {me.tenant.name}
          <br />
          {me.user.email}
        </div>
        <a
          href="#/login"
          onClick={() => {
            setToken(null);
            setActAs(null);
            setAuthed(false);
          }}
        >
          Log out
        </a>
      </nav>
      <main>
        {me.actingAs && (
          <div className="acting">
            You are working inside <b>{me.tenant.name}</b> as the vanibot team.{" "}
            <button className="secondary" onClick={() => { setActAs(null); location.hash = "#/team"; location.reload(); }}>Back to my account</button>
          </div>
        )}
        {page}
      </main>
    </div>
  );
}

function AuthPage({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">(location.hash.startsWith("#/signup") ? "signup" : "login");
  const [form, setForm] = useState({ company: "", name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = mode === "login" ? { email: form.email, password: form.password } : form;
      const { token } = await api(`/api/auth/${mode}`, { body });
      setToken(token);
      location.hash = "#/";
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <h1>vanibot</h1>
      <form className="card" onSubmit={submit}>
        <h2>{mode === "login" ? "Log in" : "Start your free pilot"}</h2>
        {mode === "signup" && (
          <>
            <p><label>Company name</label><input value={form.company} onChange={set("company")} required /></p>
            <p><label>Your name</label><input value={form.name} onChange={set("name")} required /></p>
          </>
        )}
        <p><label>Email</label><input type="email" value={form.email} onChange={set("email")} required /></p>
        <p><label>Password</label><input type="password" value={form.password} onChange={set("password")} minLength={8} required /></p>
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{mode === "login" ? "Log in" : "Create account"}</button>
        <p className="muted">
          {mode === "login" ? "New here? " : "Have an account? "}
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === "login" ? "signup" : "login"); }}>
            {mode === "login" ? "Create an account" : "Log in"}
          </a>
        </p>
      </form>
    </div>
  );
}
