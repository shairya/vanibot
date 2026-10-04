import pgvector from "pgvector";
import { query } from "../db.js";
import { embed, vectorSearchAvailable } from "./embeddings.js";

export type RetrievedChunk = { id: number; content: string; title: string; score: number };

// Hybrid search: Postgres full-text + pgvector cosine (when available), merged with reciprocal rank fusion.
export async function retrieve(tenantId: string, botId: string, question: string, k = 6): Promise<RetrievedChunk[]> {
  const keyword = await query<{ id: number; content: string; title: string }>(
    `SELECT c.id, c.content, d.title
       FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.tenant_id = $1 AND c.bot_id = $2
        AND c.tsv @@ websearch_to_tsquery('english', $3)
      ORDER BY ts_rank(c.tsv, websearch_to_tsquery('english', $3)) DESC
      LIMIT 20`,
    [tenantId, botId, question],
  );

  // websearch_to_tsquery ANDs terms; for chatty questions fall back to OR-ing the words.
  let loose: typeof keyword = [];
  if (keyword.length < k) {
    const words = question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    if (words.length) {
      loose = await query(
        `SELECT c.id, c.content, d.title
           FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.tenant_id = $1 AND c.bot_id = $2
            AND c.tsv @@ to_tsquery('english', $3)
          ORDER BY ts_rank(c.tsv, to_tsquery('english', $3)) DESC
          LIMIT 20`,
        [tenantId, botId, words.map((w) => w.replace(/[^a-z0-9]/g, "")).join(" | ")],
      );
    }
  }

  let semantic: typeof keyword = [];
  const vectors = (await vectorSearchAvailable()) ? await embed([question], "query").catch(() => null) : null;
  if (vectors) {
    semantic = await query(
      `SELECT c.id, c.content, d.title
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.tenant_id = $1 AND c.bot_id = $2 AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $3
        LIMIT 20`,
      [tenantId, botId, pgvector.toSql(vectors[0])],
    );
  }

  const scores = new Map<number, RetrievedChunk>();
  for (const list of [keyword, loose, semantic]) {
    list.forEach((row, rank) => {
      const prev = scores.get(row.id);
      const add = 1 / (60 + rank);
      scores.set(row.id, { ...row, score: (prev?.score ?? 0) + add });
    });
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, k);
  if (ranked.length > 0) return ranked;

  // Nothing matched. A small knowledge base fits in the prompt whole, so give Claude all of it.
  const all = await query<{ id: number; content: string; title: string }>(
    `SELECT c.id, c.content, d.title FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE c.tenant_id = $1 AND c.bot_id = $2 ORDER BY d.created_at, c.ordinal LIMIT $3`,
    [tenantId, botId, SMALL_KNOWLEDGE_BASE + 1],
  );
  return all.length <= SMALL_KNOWLEDGE_BASE ? all.map((r) => ({ ...r, score: 0 })) : [];
}

const SMALL_KNOWLEDGE_BASE = 8;

export function formatKnowledge(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "<knowledge>\nNo matching company documents were found for this message.\n</knowledge>";
  const body = chunks.map((c, i) => `[${i + 1}] (${c.title})\n${c.content}`).join("\n\n");
  return `<knowledge>\n${body}\n</knowledge>`;
}
