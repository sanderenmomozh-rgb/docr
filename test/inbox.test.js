import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  scanInbox,
  loadInboxState,
  saveInboxState,
  listInbox,
  confirmInbox,
  rejectInbox,
  detectType,
  previewInboxFile,
  summarizeInboxFile,
  archiveSource,
} from "../src/inbox.js";

let tmpDir;

async function setupVault(files = {}) {
  const vault = await mkdtemp(join(tmpdir(), "docr-test-"));
  const inbox = join(vault, "00_Inbox");
  await mkdir(inbox, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(inbox, name), content);
  }
  return vault;
}

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "docr-tests-"));
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── scanInbox ──

describe("scanInbox", () => {
  it("returns empty array for missing inbox dir", async () => {
    const vault = join(tmpDir, "empty-vault");
    await mkdir(vault, { recursive: true });
    const files = await scanInbox(vault);
    assert.deepStrictEqual(files, []);
  });

  it("finds all file types in inbox", async () => {
    const vault = await setupVault({
      "test.md": "# Hello",
      "data.csv": "a,b,c\n1,2,3",
      "notes.txt": "plain text",
    });
    const files = await scanInbox(vault);
    assert.strictEqual(files.length, 3);
    assert.ok(files.every((f) => f.filename && f.path && f.ext));
    await rm(vault, { recursive: true, force: true });
  });

  it("returns correct metadata fields", async () => {
    const vault = await setupVault({ "readme.md": "# Test" });
    const files = await scanInbox(vault);
    assert.strictEqual(files.length, 1);
    const f = files[0];
    assert.strictEqual(f.filename, "readme.md");
    assert.strictEqual(f.ext, ".md");
    assert.ok(typeof f.size === "number");
    assert.ok(typeof f.mtimeMs === "number");
    await rm(vault, { recursive: true, force: true });
  });

  it("sorts by filename", async () => {
    const vault = await setupVault({
      "c.md": "c",
      "a.md": "a",
      "b.md": "b",
    });
    const files = await scanInbox(vault);
    const names = files.map((f) => f.filename);
    assert.deepStrictEqual(names, ["a.md", "b.md", "c.md"]);
    await rm(vault, { recursive: true, force: true });
  });
});

// ── State management ──

describe("inbox state management", () => {
  it("loadInboxState returns empty state when file missing", async () => {
    const vault = await setupVault({});
    const state = await loadInboxState(vault);
    assert.deepStrictEqual(state, { version: 1, items: {} });
    await rm(vault, { recursive: true, force: true });
  });

  it("saveInboxState + loadInboxState roundtrip", async () => {
    const vault = await setupVault({});
    const state = { version: 1, items: { "test.md": { status: "pending" } } };
    await saveInboxState(vault, state);
    const loaded = await loadInboxState(vault);
    assert.deepStrictEqual(loaded, state);
    await rm(vault, { recursive: true, force: true });
  });

  it("listInbox defaults new items to pending", async () => {
    const vault = await setupVault({ "new.md": "# new" });
    const items = await listInbox(vault);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].status, "pending");
    await rm(vault, { recursive: true, force: true });
  });

  it("listInbox filters by status", async () => {
    const vault = await setupVault({
      "a.md": "# a",
      "b.md": "# b",
      "c.md": "# c",
    });
    await confirmInbox(vault, "a.md");
    await rejectInbox(vault, "b.md", "no");

    const all = await listInbox(vault, "all");
    assert.strictEqual(all.length, 3);

    const pending = await listInbox(vault, "pending");
    assert.strictEqual(pending.length, 1);
    assert.strictEqual(pending[0].filename, "c.md");

    const confirmed = await listInbox(vault, "confirmed");
    assert.strictEqual(confirmed.length, 1);
    assert.strictEqual(confirmed[0].filename, "a.md");

    const rejected = await listInbox(vault, "rejected");
    assert.strictEqual(rejected.length, 1);
    assert.strictEqual(rejected[0].filename, "b.md");

    await rm(vault, { recursive: true, force: true });
  });

  it("prunes state entries for deleted files", async () => {
    const vault = await setupVault({ "keep.md": "# keep" });
    // Manually inject a stale entry
    const state = await loadInboxState(vault);
    state.items["deleted.md"] = { status: "confirmed" };
    await saveInboxState(vault, state);

    const items = await listInbox(vault);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].filename, "keep.md");

    // Check state file is pruned
    const reloaded = await loadInboxState(vault);
    assert.ok(!reloaded.items["deleted.md"]);

    await rm(vault, { recursive: true, force: true });
  });
});

// ── Confirm / Reject ──

describe("confirmInbox and rejectInbox", () => {
  it("transitions pending -> confirmed", async () => {
    const vault = await setupVault({ "test.md": "# test" });
    await confirmInbox(vault, "test.md", { type: "note", notes: "ok" });
    const items = await listInbox(vault);
    assert.strictEqual(items[0].status, "confirmed");
    assert.ok(items[0].confirmedAt);
    assert.strictEqual(items[0].type, "note");
    assert.strictEqual(items[0].notes, "ok");
    await rm(vault, { recursive: true, force: true });
  });

  it("transitions pending -> rejected with reason", async () => {
    const vault = await setupVault({ "test.md": "# test" });
    await rejectInbox(vault, "test.md", "outdated");
    const items = await listInbox(vault);
    assert.strictEqual(items[0].status, "rejected");
    assert.ok(items[0].rejectedAt);
    assert.strictEqual(items[0].reason, "outdated");
    await rm(vault, { recursive: true, force: true });
  });

  it("re-confirming a rejected item works", async () => {
    const vault = await setupVault({ "test.md": "# test" });
    await rejectInbox(vault, "test.md", "wrong");
    await confirmInbox(vault, "test.md");
    const items = await listInbox(vault);
    assert.strictEqual(items[0].status, "confirmed");
    assert.strictEqual(items[0].reason, null);
    await rm(vault, { recursive: true, force: true });
  });
});

// ── detectType ──

describe("detectType", () => {
  it("classifies faq CSV by filename", () => {
    assert.strictEqual(detectType({ filename: "FAQ标准版.csv", ext: ".csv" }), "faq-csv");
    assert.strictEqual(detectType({ filename: "问答数据.csv", ext: ".csv" }), "faq-csv");
  });

  it("classifies field spec CSV by filename", () => {
    assert.strictEqual(detectType({ filename: "咨询服务工单信息集 - 表单.csv", ext: ".csv" }), "field-spec");
    assert.strictEqual(detectType({ filename: "字段逻辑.csv", ext: ".csv" }), "field-spec");
  });

  it("classifies system spec by docx extension", () => {
    assert.strictEqual(detectType({ filename: "SSC2.0-流程.docx", ext: ".docx" }), "system-spec");
  });

  it("classifies planning doc by filename", () => {
    assert.strictEqual(detectType({ filename: "llm-wiki-plan.md", ext: ".md" }), "planning-doc");
  });

  it("returns unknown for unclassifiable files", () => {
    assert.strictEqual(detectType({ filename: "random.xlsx", ext: ".xlsx" }), "unknown");
  });
});

// ── previewInboxFile ──

describe("previewInboxFile", () => {
  it("returns text content for .md files", async () => {
    const vault = await setupVault({ "readme.md": "# Hello World\n\nSome content." });
    const filePath = join(vault, "00_Inbox", "readme.md");
    const result = await previewInboxFile(filePath);
    assert.strictEqual(result.type, "text");
    assert.ok(result.preview.includes("Hello World"));
    await rm(vault, { recursive: true, force: true });
  });

  it("returns csv preview with headers", async () => {
    const vault = await setupVault({ "data.csv": "name,age,city\nAlice,30,NYC\nBob,25,LA" });
    const filePath = join(vault, "00_Inbox", "data.csv");
    const result = await previewInboxFile(filePath);
    assert.strictEqual(result.type, "csv");
    assert.deepStrictEqual(result.headers, ["name", "age", "city"]);
    assert.strictEqual(result.totalRows, 2);
    await rm(vault, { recursive: true, force: true });
  });

  it("returns error for missing file", async () => {
    const vault = await setupVault({});
    const filePath = join(vault, "00_Inbox", "nonexistent.md");
    const result = await previewInboxFile(filePath);
    assert.ok(result.type === "error");
    assert.ok(result.error);
    await rm(vault, { recursive: true, force: true });
  });
});

// ── summarizeInboxFile ──

describe("summarizeInboxFile", () => {
  it("generates summary for .md file", async () => {
    const vault = await setupVault({ "readme.md": "# Hello World\n\nThis is a sample markdown document with policy information." });
    const filePath = join(vault, "00_Inbox", "readme.md");
    const result = await summarizeInboxFile(filePath, vault);
    assert.strictEqual(result.filename, "readme.md");
    assert.strictEqual(result.format, "markdown");
    assert.ok(result.wordCount > 0);
    assert.ok(typeof result.summary === "string");
    assert.ok(result.keyInfo);
    assert.ok(result.suggestedPlacement);
    await rm(vault, { recursive: true, force: true });
  });

  it("generates summary for .csv file", async () => {
    const csvContent = "一级分类,二级分类,问题,答案,chunkID\n员工关系,考勤,迟到怎么办,请联系HRBP,ch001\n员工关系,考勤,早退怎么办,请联系HRBP,ch002";
    const vault = await setupVault({ "faq.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "faq.csv");
    const result = await summarizeInboxFile(filePath, vault);
    assert.strictEqual(result.filename, "faq.csv");
    assert.strictEqual(result.type, "faq-csv");
    assert.strictEqual(result.format, "csv");
    assert.ok(result.summary.includes("rows"));
    await rm(vault, { recursive: true, force: true });
  });

  it("throws for missing file", async () => {
    const vault = await setupVault({});
    const filePath = join(vault, "00_Inbox", "nonexistent.md");
    await assert.rejects(
      async () => { await summarizeInboxFile(filePath, vault); }
    );
    await rm(vault, { recursive: true, force: true });
  });
});

// ── archiveSource ──

describe("archiveSource", () => {
  it("moves file from 00_Inbox/ to raw/sources/", async () => {
    const vault = await setupVault({ "test.csv": "col1,col2\nval1,val2" });
    const srcPath = join(vault, "00_Inbox", "test.csv");

    const destPath = await archiveSource(vault, "test.csv");

    // File should be gone from inbox
    await assert.rejects(async () => { await readFile(srcPath, "utf-8"); });

    // File should exist at destination
    const archived = await readFile(destPath, "utf-8");
    assert.ok(archived.includes("col1,col2"));

    // Path should be in raw/sources/
    assert.ok(destPath.replace(/\\/g, "/").includes("raw/sources/test.csv"));

    await rm(vault, { recursive: true, force: true });
  });

  it("handles filename conflict with date suffix", async () => {
    const vault = await setupVault({ "spec.csv": "a,b\n1,2" });
    // Pre-create a file at the target location
    const sourcesDir = join(vault, "raw", "sources");
    await mkdir(sourcesDir, { recursive: true });
    await writeFile(join(sourcesDir, "spec.csv"), "existing content");

    const destPath = await archiveSource(vault, "spec.csv");

    // Should have date suffix to avoid conflict
    const destName = destPath.split("/").pop();
    assert.ok(destName !== "spec.csv");
    assert.ok(destName.includes("spec"));
    assert.ok(destName.includes(".csv"));

    // Both files should exist
    const original = await readFile(join(sourcesDir, "spec.csv"), "utf-8");
    assert.strictEqual(original, "existing content");

    await rm(vault, { recursive: true, force: true });
  });

  it("recorded as ingested in inbox list with archived path", async () => {
    const vault = await setupVault({ "archive-me.csv": "a,b\n1,2" });

    // Mark as ingested first (simulating full ingest flow)
    const { markIngested } = await import("../src/inbox.js");
    await markIngested(vault, "archive-me.csv");
    const destPath = await archiveSource(vault, "archive-me.csv");

    // Should appear in inbox list with ingested status
    const items = await listInbox(vault, "all");
    const item = items.find((i) => i.filename === "archive-me.csv");
    assert.ok(item);
    assert.strictEqual(item.status, "ingested");
    assert.ok(item.archivedPath);

    await rm(vault, { recursive: true, force: true });
  });
});
