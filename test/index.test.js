import { describe, it } from "node:test";
import assert from "node:assert";
import { scanDirectory } from "../src/scanner.js";
import { buildIndex } from "../src/indexer.js";
import { search } from "../src/search.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, "..", "docs");

describe("scanner", () => {
  it("finds .md files in the docs directory", async () => {
    const files = await scanDirectory(docsDir);
    assert.ok(files.length >= 3, `expected at least 3 files, got ${files.length}`);
    assert.ok(files.every((f) => f.path.endsWith(".md")), "all results should be .md files");
    assert.ok(files.every((f) => typeof f.mtimeMs === "number"), "each file should have mtimeMs");
  });
});

describe("indexer", () => {
  it("builds an index from scanned files", async () => {
    const files = await scanDirectory(docsDir);
    const { index } = await buildIndex(files);
    assert.strictEqual(index.documentCount, files.length);
  });
});

describe("search", () => {
  it("finds documents by keyword", async () => {
    const files = await scanDirectory(docsDir);
    const { index, bodies } = await buildIndex(files);
    const results = search(index, bodies, "markdown");
    assert.ok(results.length >= 1, "should find at least one match for 'markdown'");
    assert.ok(results.some((r) => r.filename.includes("markdown")), "should include the markdown cheatsheet");
  });

  it("finds documents by tag", async () => {
    const files = await scanDirectory(docsDir);
    const { index, bodies } = await buildIndex(files);
    const results = search(index, bodies, "ideas");
    assert.ok(results.length >= 1, "should find matches for 'ideas'");
  });

  it("returns empty array for nonsense query", async () => {
    const files = await scanDirectory(docsDir);
    const { index, bodies } = await buildIndex(files);
    const results = search(index, bodies, "xyznonexistent12345");
    assert.deepStrictEqual(results, []);
  });
});
