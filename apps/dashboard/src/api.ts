const base = import.meta.env.VITE_API_URL ?? "";

export function getToken() {
  return localStorage.getItem("vanibot:token");
}
export function setToken(token: string | null) {
  if (token) localStorage.setItem("vanibot:token", token);
  else localStorage.removeItem("vanibot:token");
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET"),
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401 && token) {
    setToken(null);
    location.hash = "#/login";
  }
  const text = await res.text();
  const data = text ? (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function downloadLeadsCsv() {
  const res = await fetch(base + "/api/leads.csv", { headers: { authorization: `Bearer ${getToken()}` } });
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "leads.csv";
  a.click();
}
