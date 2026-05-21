import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { scanDirectory } from "../src/scanner.js";
import { buildIndex } from "../src/indexer.js";
import { startServer } from "../src/server.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, "..", "docs");
const PORT = 3099;

let server;
let baseUrl;

before(async () => {
  const files = await scanDirectory(docsDir);
  const { index, bodies } = await buildIndex(files);
  server = startServer(index, bodies, PORT);
  baseUrl = `http://localhost:${PORT}`;
});

after(() => {
  if (server) server.close();
});

describe("server", () => {
  it("serves the search page on GET /", async () => {
    const res = await fetch(baseUrl + "/");
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("Doc Organizer"), "page should contain Doc Organizer title");
    assert.ok(html.includes("<input"), "page should contain search input");
  });

  it("returns search results with correct fields", async () => {
    const res = await fetch(baseUrl + "/search?q=markdown");
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.length >= 1, "should find at least one result for 'markdown'");
    const first = data[0];
    assert.ok(typeof first.title === "string", "result should have title");
    assert.ok(typeof first.filename === "string", "result should have filename");
    assert.ok(Array.isArray(first.tags), "result should have tags array");
    assert.ok(typeof first.snippet === "string", "result should have snippet");
    assert.ok(first.title.length > 0, "title should not be empty");
  });

  it("returns empty array for nonsense query", async () => {
    const res = await fetch(baseUrl + "/search?q=xyznonexistent12345");
    const data = await res.json();
    assert.deepStrictEqual(data, []);
  });

  it("returns empty array for empty query", async () => {
    const res = await fetch(baseUrl + "/search?q=");
    const data = await res.json();
    assert.deepStrictEqual(data, []);
  });
});
