import { describe, expect, it } from "vitest";
import { chunkText, extractText } from "../src/core/ingest.js";

describe("chunkText", () => {
  it("keeps short text in one chunk", () => {
    expect(chunkText("Hello world.\n\nSecond para.")).toEqual(["Hello world.\n\nSecond para."]);
  });
  it("splits long text into bounded chunks", () => {
    const text = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} talks about bills.`).join(" ");
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
  });
});

describe("extractText", () => {
  it("reads html and txt", async () => {
    expect((await extractText("a.html", Buffer.from("<h1>Fees</h1><p>Free review</p>"))).toLowerCase()).toContain("free review");
    expect(await extractText("a.txt", Buffer.from("plain"))).toBe("plain");
  });
  it("rejects unknown types", async () => {
    await expect(extractText("a.exe", Buffer.from(""))).rejects.toThrow(/Unsupported/);
  });
});
