import "./style.css";

const API = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const DASHBOARD = (import.meta.env.VITE_DASHBOARD_URL ?? "http://localhost:5173").replace(/\/$/, "");

// Header and footer are shared by every page.
const page = document.body.dataset.page ?? "";
const nav = [
  ["/", "Home", "home"],
  ["/demo.html", "Live demos", "demo"],
  ["/pricing.html", "Pricing", "pricing"],
  ["/contact.html", "Book a demo", "contact"],
];
document.body.insertAdjacentHTML(
  "afterbegin",
  `<header class="site"><div class="wrap bar">
    <a class="logo" href="/"><span class="dot"></span>vanibot</a>
    <button class="menu" aria-label="Menu" aria-expanded="false">&#9776;</button>
    <nav>${nav.map(([href, label, id]) => `<a href="${href}"${id === page ? ' aria-current="page"' : ""}>${label}</a>`).join("")}
      <a href="${DASHBOARD}/#/login" class="quiet">Log in</a>
      <a href="${DASHBOARD}/#/signup" class="btn small">Start free pilot</a></nav>
  </div></header>`,
);
document.body.insertAdjacentHTML(
  "beforeend",
  `<footer class="site"><div class="wrap cols">
    <div><a class="logo" href="/"><span class="dot"></span>vanibot</a><p class="muted">AI chat and voice assistants for Indian businesses, on WhatsApp and your website.</p></div>
    <div><b>Product</b><a href="/demo.html">Live demos</a><a href="/pricing.html">Pricing</a><a href="${DASHBOARD}/#/signup">Sign up</a></div>
    <div><b>Company</b><a href="/contact.html">Contact</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a></div>
  </div><div class="wrap muted small">© ${new Date().getFullYear()} vanibot</div></footer>`,
);
const menu = document.querySelector<HTMLButtonElement>("header .menu");
menu?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  menu.setAttribute("aria-expanded", String(open));
});

for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-signup]")) a.href = `${DASHBOARD}/#/signup`;

// ---------- Pricing ----------
type Plan = { id: string; name: string; priceLabel: string; tagline: string; channels: string[]; bots: number; conversationsPerMonth: number; voiceNotesPerMonth: number; documents: number };
const CHANNELS: Record<string, string> = { web: "Website chat", whatsapp: "WhatsApp chat", voice: "WhatsApp voice notes and website voice" };

async function renderPricing(el: HTMLElement) {
  try {
    const plans = (await (await fetch(`${API}/api/public/plans`)).json()) as Plan[];
    el.innerHTML = plans
      .filter((p) => p.id !== "pilot")
      .map(
        (p) => `<div class="plan${p.id === "chat_voice" ? " featured" : ""}">
          ${p.id === "chat_voice" ? '<div class="tag">Most popular</div>' : ""}
          <h3>${p.name}</h3><div class="price">${p.priceLabel}</div><p class="muted">${p.tagline}</p>
          <ul>${p.channels.map((c) => `<li>${CHANNELS[c]}</li>`).join("")}
            <li>${p.bots} bot${p.bots > 1 ? "s" : ""}</li>
            <li>${p.conversationsPerMonth.toLocaleString("en-IN")} conversations a month</li>
            ${p.voiceNotesPerMonth ? `<li>${p.voiceNotesPerMonth.toLocaleString("en-IN")} voice notes a month</li>` : ""}
            <li>${p.documents} knowledge documents</li>
            <li>English and 10 Indian languages</li></ul>
          <a class="btn${p.id === "chat_voice" ? "" : " ghost"}" href="/contact.html?plan=${p.id}">Talk to us</a></div>`,
      )
      .join("");
  } catch {
    el.innerHTML = '<p class="muted">Prices could not be loaded right now. <a href="/contact.html">Contact us</a> for a quote.</p>';
  }
}
const pricing = document.getElementById("plans");
if (pricing) void renderPricing(pricing);

// ---------- Live demos ----------
const demoBots: Record<string, { key: string; title: string }> = {
  medical: { key: "pk_demo_medical", title: "Medical bill discounts" },
  insurance: { key: "pk_demo_insurance", title: "Insurance" },
  lending: { key: "pk_demo_lending", title: "Loans" },
};
const demoTabs = document.querySelectorAll<HTMLButtonElement>("[data-demo]");
if (demoTabs.length) {
  const chosen = new URLSearchParams(location.search).get("bot") ?? "medical";
  const bot = demoBots[chosen] ?? demoBots.medical;
  for (const t of demoTabs) {
    if (t.dataset.demo === chosen) t.setAttribute("aria-pressed", "true");
    t.addEventListener("click", () => {
      location.search = `?bot=${t.dataset.demo}`; // reload so the widget starts fresh for that company
    });
  }
  const s = document.createElement("script");
  s.src = `${API}/widget.js`;
  s.async = true;
  s.dataset.bot = bot.key;
  document.body.appendChild(s);
  const title = document.getElementById("demo-title");
  if (title) title.textContent = bot.title;
  // Open the chat panel once the widget has loaded.
  const opener = setInterval(() => {
    const launcher = document.getElementById("vanibot-widget")?.shadowRoot?.querySelector<HTMLButtonElement>(".launcher");
    if (launcher) {
      clearInterval(opener);
      launcher.click();
    }
  }, 300);
  setTimeout(() => clearInterval(opener), 10_000);
}

// ---------- Book a demo ----------
const form = document.querySelector<HTMLFormElement>("#demo-form");
if (form) {
  const plan = new URLSearchParams(location.search).get("plan");
  const interest = form.elements.namedItem("interest") as HTMLSelectElement | null;
  if (plan && interest && [...interest.options].some((o) => o.value === plan)) interest.value = plan;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = form.querySelector<HTMLElement>(".status")!;
    const button = form.querySelector<HTMLButtonElement>("button")!;
    button.disabled = true;
    status.className = "status";
    status.textContent = "Sending...";
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const res = await fetch(`${API}/api/public/demo-requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      form.reset();
      status.className = "status ok";
      status.textContent = "Thank you! Our team will contact you within one working day.";
    } catch (err) {
      status.className = "status bad";
      status.textContent = err instanceof Error ? err.message : "Something went wrong.";
    } finally {
      button.disabled = false;
    }
  });
}
