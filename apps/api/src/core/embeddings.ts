import { config } from "../config.js";

// Voyage AI embeddings (1024 dims). Optional: without a key, retrieval uses keyword search only.
export const embeddingsEnabled = () => Boolean(config.voyage.apiKey);

export async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][] | null> {
  if (!embeddingsEnabled() || texts.length === 0) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.voyage.apiKey}` },
      body: JSON.stringify({ input: texts.slice(i, i + 64), model: config.voyage.model, input_type: inputType }),
    });
    if (!res.ok) throw new Error(`Voyage embeddings failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    out.push(...json.data.map((d) => d.embedding));
  }
  return out;
}
