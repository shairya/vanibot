import { convert as htmlToText } from "html-to-text";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import pgvector from "pgvector";
import { one, query, withTransaction } from "../db.js";
import { embed } from "./embeddings.js";
import { registerJobHandler } from "./jobs.js";

export async function extractText(filename: string, data: Buffer): Promise<string> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(data) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (lower.endsWith(".docx")) return (await mammoth.extractRawText({ buffer: data })).value;
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return htmlToText(data.toString("utf8"), { wordwrap: false });
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".csv")) return data.toString("utf8");
  throw new Error("Unsupported file type. Upload PDF, DOCX, HTML, TXT, MD or CSV.");
}

export async function fetchUrlText(url: string): Promise<{ title: string; text: string }> {
  const res = await fetch(url, { headers: { "user-agent": "vanibot-crawler/1.0" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Fetching ${url} failed with ${res.status}`);
  const html = await res.text();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || url;
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  });
  return { title, text };
}

// Split into ~1800-character chunks on paragraph/sentence boundaries with a small overlap.
export function chunkText(text: string, size = 1800, overlap = 200): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const paragraphs = clean.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = current.length > overlap ? current.slice(-overlap) : "";
  };
  for (const para of paragraphs) {
    if (para.length > size) {
      for (const sentence of para.split(/(?<=[.!?])\s+/)) {
        if (current.length + sentence.length + 1 > size) pushCurrent();
        current += (current ? " " : "") + sentence;
        while (current.length > size) {
          chunks.push(current.slice(0, size));
          current = current.slice(size - overlap);
        }
      }
      continue;
    }
    if (current.length + para.length + 2 > size) pushCurrent();
    current += (current ? "\n\n" : "") + para;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export async function ingestDocument(documentId: string) {
  const doc = await one("SELECT id, tenant_id, bot_id, kind, source, raw_text FROM documents WHERE id = $1", [documentId]);
  if (!doc) return;
  await query("UPDATE documents SET status = 'processing', error = NULL WHERE id = $1", [documentId]);
  try {
    let text: string = doc.raw_text ?? "";
    if (doc.kind === "url") {
      const page = await fetchUrlText(doc.source);
      text = page.text;
      await query("UPDATE documents SET raw_text = $2, title = $3 WHERE id = $1", [documentId, text, page.title]);
    }
    const pieces = chunkText(text);
    if (pieces.length === 0) throw new Error("No text could be extracted from this document.");
    const vectors = await embed(pieces, "document");
    await withTransaction(async (client) => {
      await client.query("DELETE FROM chunks WHERE document_id = $1", [documentId]);
      for (let i = 0; i < pieces.length; i++) {
        await client.query(
          "INSERT INTO chunks(tenant_id, bot_id, document_id, ordinal, content, embedding) VALUES ($1, $2, $3, $4, $5, $6)",
          [doc.tenant_id, doc.bot_id, documentId, i, pieces[i], vectors ? pgvector.toSql(vectors[i]) : null],
        );
      }
      await client.query("UPDATE documents SET status = 'ready', chunk_count = $2 WHERE id = $1", [documentId, pieces.length]);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query("UPDATE documents SET status = 'failed', error = $2 WHERE id = $1", [documentId, message.slice(0, 1000)]);
  }
}

registerJobHandler("ingest_document", async (p: { documentId: string }) => {
  await ingestDocument(p.documentId);
});
