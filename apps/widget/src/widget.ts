// vanibot embeddable widget: <script src="https://YOUR-API/widget.js" data-bot="pk_..." async></script>
// Renders inside a shadow root so the host page's CSS can't break it (and vice versa).

type WidgetConfig = {
  botName: string;
  companyName: string;
  greeting: string;
  suggestedQuestions: string[];
  theme: { color: string; position: "right" | "left" };
  voice: { enabled: boolean; lang: string };
  showBranding: boolean;
};

type StreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; event: { type: "lead_captured" | "handoff_requested" } }
  | { type: "done"; text: string };

const script = (document.currentScript as HTMLScriptElement | null) ?? document.querySelector<HTMLScriptElement>("script[data-bot]");
const botKey = script?.dataset.bot ?? "";
const apiBase = script ? new URL(script.src).origin : "";

function storage(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return null;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Just enough markdown for chat replies: bold, italics, links, bullet lists, line breaks.
function renderMarkdown(src: string) {
  const lines = escapeHtml(src).split("\n");
  let html = "";
  let inList = false;
  for (const line of lines) {
    const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (item) {
      if (!inList) html += "<ul>";
      inList = true;
      html += `<li>${item[1]}</li>`;
      continue;
    }
    if (inList) html += "</ul>";
    inList = false;
    html += line ? `<p>${line}</p>` : "";
  }
  if (inList) html += "</ul>";
  return html
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function toSpeech(text: string) {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#`>]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

const css = (color: string, side: "right" | "left") => `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.launcher { position: fixed; bottom: 20px; ${side}: 20px; width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer;
  background: ${color}; color: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
.launcher svg { width: 28px; height: 28px; }
.panel { position: fixed; bottom: 92px; ${side}: 20px; width: 370px; max-width: calc(100vw - 32px); height: 560px; max-height: calc(100vh - 120px);
  background: #fff; border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,.25); display: none; flex-direction: column; overflow: hidden; z-index: 2147483000; color: #111827; }
.panel.open { display: flex; }
@media (max-width: 480px) { .panel { inset: 0; width: 100vw; max-width: 100vw; height: 100%; max-height: 100%; border-radius: 0; bottom: 0; } }
.header { background: ${color}; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }
.header .title { font-weight: 600; font-size: 15px; flex: 1; }
.header .sub { font-size: 12px; opacity: .85; font-weight: 400; }
.header button { background: transparent; border: none; color: #fff; cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; }
.messages { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 8px; background: #f9fafb; }
.msg { max-width: 85%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.45; word-wrap: break-word; }
.msg p { margin: 0 0 6px; } .msg p:last-child { margin: 0; } .msg ul { margin: 4px 0; padding-left: 18px; }
.msg a { color: inherit; text-decoration: underline; }
.bot { background: #fff; border: 1px solid #e5e7eb; align-self: flex-start; border-bottom-left-radius: 4px; }
.user { background: ${color}; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
.note { align-self: center; font-size: 12px; color: #047857; background: #ecfdf5; padding: 4px 10px; border-radius: 999px; }
.typing { align-self: flex-start; color: #6b7280; font-size: 13px; padding: 4px 2px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; background: #f9fafb; }
.chip { border: 1px solid ${color}; color: ${color}; background: #fff; border-radius: 999px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
.composer { display: flex; gap: 6px; padding: 10px; border-top: 1px solid #e5e7eb; background: #fff; }
.composer input { flex: 1; border: 1px solid #d1d5db; border-radius: 10px; padding: 10px 12px; font-size: 14px; outline: none; }
.composer input:focus { border-color: ${color}; }
.icon { width: 40px; border: none; border-radius: 10px; cursor: pointer; background: ${color}; color: #fff; display: flex; align-items: center; justify-content: center; }
.icon.secondary { background: #f3f4f6; color: #374151; }
.icon.listening { background: #dc2626; color: #fff; animation: pulse 1.2s infinite; }
.icon svg { width: 18px; height: 18px; }
@keyframes pulse { 50% { opacity: .6; } }
.brand { text-align: center; font-size: 11px; color: #9ca3af; padding: 4px 0 8px; background: #fff; }
.brand a { color: inherit; }
`;

const icons = {
  chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>',
};

async function main() {
  if (!botKey || !apiBase) return console.warn("vanibot: missing data-bot attribute on the script tag");
  const res = await fetch(`${apiBase}/v1/widget/${botKey}/config`);
  if (!res.ok) return console.warn("vanibot: assistant unavailable", res.status);
  const cfg = (await res.json()) as WidgetConfig;

  const host = document.createElement("div");
  host.id = "vanibot-widget";
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${css(cfg.theme.color, cfg.theme.position)}</style>
    <button class="launcher" aria-label="Open chat">${icons.chat}</button>
    <div class="panel" role="dialog" aria-label="${escapeHtml(cfg.botName)}">
      <div class="header"><div class="title">${escapeHtml(cfg.botName)}<div class="sub">${escapeHtml(cfg.companyName)}</div></div>
        <button class="reset" title="Start over" aria-label="Start a new conversation">&#8635;</button>
        <button class="close" aria-label="Close chat">&times;</button></div>
      <div class="messages" aria-live="polite"></div>
      <div class="chips"></div>
      <form class="composer"><input type="text" placeholder="Type your message..." aria-label="Message" maxlength="2000" />
        ${cfg.voice.enabled ? `<button type="button" class="icon secondary mic" aria-label="Speak">${icons.mic}</button>` : ""}
        <button type="submit" class="icon" aria-label="Send">${icons.send}</button></form>
      ${cfg.showBranding ? '<div class="brand">Powered by vanibot</div>' : ""}
    </div>`;

  const $ = <T extends Element>(sel: string) => root.querySelector(sel) as T;
  const panel = $<HTMLDivElement>(".panel");
  const list = $<HTMLDivElement>(".messages");
  const chips = $<HTMLDivElement>(".chips");
  const form = $<HTMLFormElement>(".composer");
  const input = $<HTMLInputElement>("input");
  const micBtn = root.querySelector<HTMLButtonElement>(".mic");

  const convKey = `vanibot:${botKey}:conversation`;
  let conversationId = storage(convKey);
  let busy = false;
  let voiceMode = false;
  let loaded = false;

  const scroll = () => (list.scrollTop = list.scrollHeight);
  const addMessage = (role: "bot" | "user", text: string) => {
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.innerHTML = role === "bot" ? renderMarkdown(text) : escapeHtml(text);
    list.appendChild(el);
    scroll();
    return el;
  };
  const addNote = (text: string) => {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = text;
    list.appendChild(el);
    scroll();
  };
  const renderChips = (show: boolean) => {
    chips.innerHTML = "";
    if (!show) return;
    for (const q of cfg.suggestedQuestions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = q;
      b.onclick = () => send(q, false);
      chips.appendChild(b);
    }
  };

  async function loadHistory() {
    loaded = true;
    list.innerHTML = "";
    addMessage("bot", cfg.greeting);
    if (conversationId) {
      const r = await fetch(`${apiBase}/v1/widget/${botKey}/conversations/${conversationId}/messages`);
      if (r.ok) {
        const rows = (await r.json()) as { role: string; text: string }[];
        for (const m of rows) addMessage(m.role === "user" ? "user" : "bot", m.text);
        renderChips(rows.length === 0);
        return;
      }
      conversationId = null;
      storage(convKey, null);
    }
    renderChips(true);
  }

  async function ensureConversation(viaVoice: boolean) {
    if (conversationId) return conversationId;
    const r = await fetch(`${apiBase}/v1/widget/${botKey}/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: viaVoice ? "web_voice" : "web", visitorId: getVisitorId() }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error ?? "Unavailable");
    conversationId = body.conversationId as string;
    storage(convKey, conversationId);
    return conversationId;
  }

  function getVisitorId() {
    const k = "vanibot:visitor";
    let id = storage(k);
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      storage(k, id);
    }
    return id;
  }

  async function send(text: string, viaVoice: boolean) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    renderChips(false);
    addMessage("user", text);
    input.value = "";
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.textContent = `${cfg.botName} is typing...`;
    list.appendChild(typing);
    scroll();

    let bubble: HTMLDivElement | null = null;
    let full = "";
    try {
      const id = await ensureConversation(viaVoice);
      const r = await fetch(`${apiBase}/v1/widget/${botKey}/conversations/${id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!r.ok || !r.body) {
        if (r.status === 404) {
          conversationId = null;
          storage(convKey, null);
        }
        throw new Error((await r.json().catch(() => ({}))).error ?? "Something went wrong");
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!raw.startsWith("data: ")) continue;
          const ev = JSON.parse(raw.slice(6)) as StreamEvent;
          if (ev.type === "text") {
            typing.remove();
            full += ev.text;
            if (!bubble) bubble = addMessage("bot", full);
            else bubble.innerHTML = renderMarkdown(full);
            scroll();
          } else if (ev.type === "tool") {
            addNote(ev.event.type === "lead_captured" ? "✓ Your details were sent to the team" : "✓ A team member has been notified");
            bubble = null; // continue the reply in a fresh bubble after the note
            full = "";
          }
        }
      }
    } catch (err) {
      typing.remove();
      addMessage("bot", err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      typing.remove();
      busy = false;
      if (voiceMode && full) speak(full);
      else if (!voiceMode) input.focus();
    }
  }

  // ---- Voice: browser speech recognition in, speech synthesis out ----
  const Recognition: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let recognizer: any = null;
  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(toSpeech(text));
    u.lang = cfg.voice.lang;
    u.onend = () => voiceMode && listen(); // hands-free: listen again after speaking
    speechSynthesis.speak(u);
  }
  function stopListening() {
    recognizer?.abort();
    recognizer = null;
    micBtn?.classList.remove("listening");
  }
  function listen() {
    if (!Recognition || !panel.classList.contains("open")) return;
    stopListening();
    recognizer = new Recognition();
    recognizer.lang = cfg.voice.lang;
    recognizer.interimResults = true;
    recognizer.onresult = (e: any) => {
      const result = e.results[e.results.length - 1];
      input.value = result[0].transcript;
      if (result.isFinal) {
        stopListening();
        void send(input.value, true);
      }
    };
    recognizer.onerror = () => stopListening();
    recognizer.onend = () => micBtn?.classList.remove("listening");
    micBtn?.classList.add("listening");
    recognizer.start();
  }
  if (micBtn) {
    if (!Recognition) micBtn.style.display = "none";
    micBtn.onclick = () => {
      if (recognizer) {
        voiceMode = false;
        stopListening();
        speechSynthesis?.cancel();
        return;
      }
      voiceMode = true;
      listen();
    };
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    voiceMode = false;
    void send(input.value, false);
  };
  $<HTMLButtonElement>(".launcher").onclick = () => {
    panel.classList.toggle("open");
    if (panel.classList.contains("open")) {
      if (!loaded) void loadHistory();
      input.focus();
    } else {
      voiceMode = false;
      stopListening();
    }
  };
  $<HTMLButtonElement>(".close").onclick = () => {
    panel.classList.remove("open");
    voiceMode = false;
    stopListening();
  };
  $<HTMLButtonElement>(".reset").onclick = () => {
    conversationId = null;
    storage(convKey, null);
    void loadHistory();
  };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void main());
else void main();
