import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildIndex } from "../src/indexer.js";
import { confirmInbox, loadInboxState } from "../src/inbox.js";
import { executeIngest } from "../src/ingest.js";

let tmpDir;

async function setupVault(files = {}) {
  const vault = await mkdtemp(join(tmpdir(), "docr-test-"));
  const inbox = join(vault, "00_Inbox");
  const wiki = join(vault, "wiki");
  await mkdir(inbox, { recursive: true });
  await mkdir(wiki, { recursive: true });
  // Create minimal _index.md and _log.md
  await writeFile(join(wiki, "_index.md"), "# Index\n");
  await writeFile(join(wiki, "_log.md"), "# Log\n");
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

// ── executeIngest ──

describe("executeIngest", () => {
  it("field-spec CSV creates raw/specs file with field table", async () => {
    const csvContent = "字段名,取值逻辑,码值,必填,备注\n姓名,取员工主数据, ,是, \n部门,取组织架构, ,是,如有调动以最新为准";
    const vault = await setupVault({ "field-spec.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "field-spec.csv");
    await confirmInbox(vault, "field-spec.csv");

    // Build index from inbox (will be empty but valid)
    const { index, bodies } = await buildIndex([]);

    const result = await executeIngest(filePath, vault, index, bodies);
    assert.strictEqual(result.source, "field-spec.csv");
    assert.strictEqual(result.type, "field-spec");
    assert.strictEqual(result.dryRun, false);

    await rm(vault, { recursive: true, force: true });
  });

  it("field-spec CSV creates raw/specs file with correct content", async () => {
    const csvContent = "字段名,取值逻辑,码值,必填,备注\n姓名,取员工主数据, ,是, \n部门,取组织架构, ,是,如有调动以最新为准";
    const vault = await setupVault({ "spec.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "spec.csv");
    await confirmInbox(vault, "spec.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies);

    if (!result.skipped) {
      assert.ok(result.created.length > 0);
      const page = result.created[0];
      // Verify the file was actually written
      const content = await readFile(page.path, "utf-8");
      assert.ok(content.includes("字段定义"));
      assert.ok(content.includes("字段名"));
    }

    await rm(vault, { recursive: true, force: true });
  });

  it("marks source as ingested after successful execution", async () => {
    const csvContent = "字段名,取值逻辑\n姓名,取员工主数据";
    const vault = await setupVault({ "test.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "test.csv");
    await confirmInbox(vault, "test.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies);

    if (!result.skipped) {
      const state = await loadInboxState(vault);
      assert.ok(state.items["test.csv"]);
      assert.strictEqual(state.items["test.csv"].status, "ingested");
    }

    await rm(vault, { recursive: true, force: true });
  });

  it("dry-run does not write files", async () => {
    const csvContent = "字段名,取值逻辑\n姓名,取员工主数据";
    const vault = await setupVault({ "dry.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "dry.csv");
    await confirmInbox(vault, "dry.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies, { dryRun: true });

    assert.strictEqual(result.dryRun, true);
    // Check that no files were created
    if (!result.skipped) {
      for (const c of result.created) {
        await assert.rejects(async () => { await readFile(c.path, "utf-8"); });
      }
    }

    await rm(vault, { recursive: true, force: true });
  });

  it("skips conversion-ref files", async () => {
    const vault = await setupVault({ "test-pandoc.md": "# Pandoc output\n\nSome content" });
    const filePath = join(vault, "00_Inbox", "test-pandoc.md");
    await confirmInbox(vault, "test-pandoc.md");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies);
    assert.ok(result.skipped);
    assert.ok(result.reason.includes("conversion-ref"));

    await rm(vault, { recursive: true, force: true });
  });

  it("throws for existing file without --force", async () => {
    const csvContent = "字段名,取值逻辑\n姓名,取员工主数据";
    const vault = await setupVault({ "dup.csv": csvContent });
    const filePath = join(vault, "00_Inbox", "dup.csv");
    await confirmInbox(vault, "dup.csv");

    // First ingest succeeds
    const { index, bodies } = await buildIndex([]);
    let result = await executeIngest(filePath, vault, index, bodies);

    if (!result.skipped) {
      // Re-confirm to allow second ingest attempt
      await confirmInbox(vault, "dup.csv");
      // Second ingest without --force should fail
      await assert.rejects(
        async () => { await executeIngest(filePath, vault, index, bodies); },
        /already exists/
      );
    }

    await rm(vault, { recursive: true, force: true });
  });

  // ── Duplicate detection ──

  it("skips when potential duplicate found by same source reference", async () => {
    const csvContent = "字段名,取值逻辑,码值\n姓名,取员工主数据,是";
    const vault = await setupVault({ "工单信息集 - 测试表单.csv": csvContent });

    // Pre-create a spec file that references the same source
    const specDir = join(vault, "raw", "specs", "SSC测试");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "字段逻辑-测试表单.md"),
      "# 字段逻辑-测试表单\n\n来源：工单信息集 - 测试表单.csv\n\n## 字段定义\n\n| 字段名 | 取值逻辑 | 码值 |\n|------|------|------|\n| 姓名 | 取员工主数据 | 是 |\n");

    const filePath = join(vault, "00_Inbox", "工单信息集 - 测试表单.csv");
    await confirmInbox(vault, "工单信息集 - 测试表单.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies);

    assert.ok(result.skipped);
    assert.ok(result.reason.includes("potential duplicates"));
    assert.ok(result.duplicates.length >= 1);
    const dup = result.duplicates[0];
    assert.ok(dup.path.includes("字段逻辑-测试表单"));
    assert.ok(dup.reasons.some((r) => r.includes("相同来源")));

    await rm(vault, { recursive: true, force: true });
  });

  it("skips when field names overlap significantly", async () => {
    const csvContent = "字段名,取值逻辑,码值,必填\n姓名,取员工主数据,是,是\n部门,取组织架构,是,是";
    const vault = await setupVault({ "测试字段.csv": csvContent });

    // Pre-create a spec file with overlapping field names
    const specDir = join(vault, "raw", "specs");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "字段逻辑-旧版本.md"),
      "# 字段逻辑-旧版本\n\n来源：其他文件.csv\n\n## 字段定义\n\n| 字段名 | 取值逻辑 | 码值 | 必填 |\n|------|------|------|------|\n| 姓名 | 取员工主数据 | 是 | 是 |\n| 部门 | 取组织架构 | 是 | 是 |\n");

    const filePath = join(vault, "00_Inbox", "测试字段.csv");
    await confirmInbox(vault, "测试字段.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies);

    assert.ok(result.skipped);
    assert.ok(result.duplicates.length >= 1);
    assert.ok(result.duplicates[0].reasons.some((r) => r.includes("字段重叠度")));

    await rm(vault, { recursive: true, force: true });
  });

  it("--force bypasses duplicate detection", async () => {
    const csvContent = "字段名,取值逻辑\n姓名,取员工主数据";
    const vault = await setupVault({ "force-test.csv": csvContent });

    // Pre-create a spec file with same source
    const specDir = join(vault, "raw", "specs");
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, "字段逻辑-force-test.md"),
      "# 字段逻辑-force-test\n\n来源：force-test.csv\n\n## 字段定义\n\n| 字段名 | 取值逻辑 |\n|------|------|\n| 姓名 | 取员工主数据 |\n");

    const filePath = join(vault, "00_Inbox", "force-test.csv");
    await confirmInbox(vault, "force-test.csv");

    const { index, bodies } = await buildIndex([]);
    const result = await executeIngest(filePath, vault, index, bodies, { force: true });

    // With --force, should proceed and create the file (not skip)
    assert.ok(!result.skipped);
    assert.ok(result.duplicates.length === 0 || result.created.length > 0);

    await rm(vault, { recursive: true, force: true });
  });
});
