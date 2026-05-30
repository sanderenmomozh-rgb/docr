import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, basename, relative } from "node:path";
import { analyzeSource } from "./analyze.js";
import { suggestLinks } from "./suggest.js";
import { markIngested } from "./inbox.js";

/**
 * Execute ingest: create wiki pages, update index/log, mark source as ingested.
 * @param {string} filePath - full path to the confirmed inbox file
 * @param {string} vaultPath - vault root
 * @param {object} index - MiniSearch index
 * @param {Map} bodies - path → { body, frontmatter }
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - preview only, no writes
 * @param {boolean} [opts.force] - overwrite existing pages
 * @returns {Promise<object>} { created: [...], updated: [...], dryRun }
 */
export async function executeIngest(filePath, vaultPath, index, bodies, opts = {}) {
  const dryRun = opts.dryRun || false;
  const force = opts.force || false;

  const analysis = await analyzeSource(filePath, vaultPath);
  const suggestions = await suggestLinks(analysis, index, bodies);
  const created = [];
  const updated = [];

  // Skip conversion-ref — these are pandoc intermediate files
  if (analysis.type === "conversion-ref") {
    return { source: analysis.filename, created: [], updated: [], skipped: true, reason: "conversion-ref — pandoc intermediate file, not a knowledge source", dryRun };
  }

  // Skip faq-csv — requires LLM batch processing (CLAUDE.md ingest workflow)
  if (analysis.type === "faq-csv") {
    return { source: analysis.filename, created: [], updated: [], skipped: true, reason: "faq-csv — use CLAUDE.md batch ingest workflow for FAQ datasets", dryRun };
  }

  const sp = analysis.suggestedPlacement;

  // Check for existing files before creating
  const toCreate = buildPagePlan(analysis, sp, vaultPath);
  if (!force) {
    for (const page of toCreate) {
      try {
        await readFile(page.path, "utf-8");
        throw new Error(`File already exists: ${page.path}. Use --force to overwrite.`);
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    }
  }

  // Check for potential duplicates (different path, same source content)
  let duplicates = [];
  if (!force) {
    duplicates = await findPotentialDuplicates(analysis, vaultPath);
  }

  if (dryRun) {
    return {
      source: analysis.filename,
      type: analysis.type,
      created: toCreate.map((p) => ({ ...p, body: p.body.slice(0, 200) + "..." })),
      updated: suggestions.filter((s) => s.score > 0.4).map((s) => ({ path: s.path, changes: ["交叉引用更新"] })),
      duplicates,
      dryRun: true,
    };
  }

  if (duplicates.length > 0) {
    return {
      source: analysis.filename,
      type: analysis.type,
      created: [],
      updated: [],
      skipped: true,
      reason: `potential duplicates found in raw/specs/ — ${duplicates.length} existing file(s) may cover the same source`,
      duplicates,
      dryRun: false,
    };
  }

  // Create page files
  for (const page of toCreate) {
    await mkdir(dirname(page.path), { recursive: true });
    const content = matterStringify(page.frontmatter, page.body);
    await writeFile(page.path, content, "utf-8");
    created.push({ path: page.path, title: page.title, template: page.template });
  }

  // Update _index.md
  await updateIndexMd(vaultPath, toCreate);

  // Append _log.md
  await appendLogMd(vaultPath, analysis.filename, toCreate);

  // Mark source as ingested
  await markIngested(vaultPath, analysis.filename);

  return {
    source: analysis.filename,
    type: analysis.type,
    created,
    updated: suggestions.filter((s) => s.score > 0.4).map((s) => ({ path: s.path, changes: ["交叉引用更新"] })),
    duplicates: [],
    dryRun: false,
  };
}

/**
 * Scan raw/specs/ for existing files that may cover the same source.
 * Returns a list of { path, reasons[] } for each potential duplicate found.
 */
async function findPotentialDuplicates(analysis, vaultPath) {
  const specsDir = join(vaultPath, "raw", "specs");
  const existing = [];

  // Collect all .md files under raw/specs/ recursively
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist — no duplicates
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".md")) {
        existing.push(full);
      }
    }
  }
  await walk(specsDir);

  if (existing.length === 0) return [];

  const sourceName = analysis.filename.replace(/\.[^.]+$/, ""); // strip extension
  const sourceTokens = tokenize(sourceName);
  const incomingHeaders = (analysis.csvHeaders || []).filter(Boolean).map((h) => h.trim());

  const results = [];

  for (const filePath of existing) {
    const reasons = [];
    let content;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    // 1. Check source reference line (e.g. "来源：xxx.csv")
    const sourceMatch = content.match(/来源[：:]\s*(.+)/);
    if (sourceMatch) {
      const refSource = sourceMatch[1].trim().replace(/\.[^.]+$/, "");
      if (refSource === sourceName) {
        reasons.push("相同来源 — 来源行指向同一个文件");
      } else {
        // Fuzzy: check token overlap of source names
        const refTokens = tokenize(refSource);
        const overlap = intersection(sourceTokens, refTokens);
        if (overlap.length >= Math.min(sourceTokens.length, refTokens.length) * 0.5) {
          reasons.push(`来源相似 — 来源行指向 "${refSource}" (关键词重叠: ${overlap.slice(0, 3).join(", ")})`);
        }
      }
    }

    // 2. For field-spec: compare field name overlap with existing table headers
    if (analysis.type === "field-spec" && incomingHeaders.length > 0) {
      const existingFields = extractFieldNames(content);
      if (existingFields.length > 0) {
        const matchCount = incomingHeaders.filter((h) =>
          existingFields.some((ef) => ef === h || ef.includes(h) || h.includes(ef))
        ).length;
        const overlapPct = Math.round((matchCount / Math.max(incomingHeaders.length, existingFields.length)) * 100);
        if (overlapPct >= 40) {
          reasons.push(`字段重叠度 ${overlapPct}% (${matchCount}/${Math.max(incomingHeaders.length, existingFields.length)})`);
        }
      }
    }

    // 3. Filename similarity (token-based)
    const existName = basename(filePath, ".md");
    const existTokens = tokenize(existName);
    const nameOverlap = intersection(sourceTokens, existTokens);
    if (nameOverlap.length >= 3) {
      reasons.push(`文件名关键词重叠: ${nameOverlap.slice(0, 5).join(", ")}`);
    }

    if (reasons.length > 0) {
      results.push({
        path: relative(vaultPath, filePath).replace(/\\/g, "/"),
        reasons,
      });
    }
  }

  return results;
}

/**
 * Tokenize a string into meaningful keywords.
 * Splits on common delimiters and filters out short noise tokens.
 */
function tokenize(str) {
  return str
    .replace(/[（(][^)）]*[)）]/g, "") // remove parenthetical content
    .split(/[\s\-—,，、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function intersection(a, b) {
  const setB = new Set(b);
  return [...new Set(a)].filter((x) => setB.has(x));
}

/**
 * Extract field names from a field-spec markdown table.
 * Looks for the first table in a "## 字段定义" section.
 */
function extractFieldNames(content) {
  // Find the field definition section
  const sectionMatch = content.match(/##\s*字段定义\s*\n+(\|[^\n]+\|\n\|[|\-\s]+\|\n((?:\|.+\|\n?)*))/);
  if (!sectionMatch) return [];

  const headerRow = sectionMatch[1].split(/\n/)[0];
  if (!headerRow) return [];

  return headerRow
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c && c !== "—" && c !== "------");
}

function buildPagePlan(analysis, sp, vaultPath) {
  const today = new Date().toISOString().slice(0, 10);
  const pages = [];

  switch (analysis.type) {
    case "field-spec": {
      const body = generateFieldSpecContent(analysis);
      pages.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`.replace(/\\/g, "/"),
        title: sp.suggestedFilename,
        template: sp.template || "raw/specs (Layer 1)",
        frontmatter: {}, // raw/specs has no wiki frontmatter
        body,
      });
      break;
    }

    case "system-spec": {
      // Feature page
      const featureBody = generateFeatureScaffold(analysis);
      pages.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: "tpl-feature.md",
        frontmatter: {
          title: sp.suggestedFilename,
          tags: ["feature", "system"],
          date: today,
          scope: analysis.keyInfo?.scope || "",
          status: "draft-pending-review",
          reviewer: "",
          review_date: "",
          aliases: [],
          system_refs: [],
          guide_refs: [],
        },
        body: featureBody,
      });

      // Guide page
      const guideName = sp.suggestedFilename.replace("特性说明", "操作指引");
      const guidePath = join(vaultPath, "wiki", "guides", `${guideName}.md`).replace(/\\/g, "/");
      const guideBody = generateGuideScaffold(analysis, sp.suggestedFilename);
      pages.push({
        path: guidePath,
        title: guideName,
        template: "tpl-guide.md",
        frontmatter: {
          title: guideName,
          tags: ["guide", "system"],
          date: today,
          scope: analysis.keyInfo?.scope || "",
          status: "draft-pending-review",
          reviewer: "",
          review_date: "",
          aliases: [],
          feature_refs: [`[[${sp.suggestedFilename}]]`],
          system_refs: [],
        },
        body: guideBody,
      });
      break;
    }

    case "policy-doc": {
      pages.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: "tpl-policy.md",
        frontmatter: {
          title: sp.suggestedFilename,
          tags: ["policy"],
          date: today,
          status: "draft-pending-review",
          reviewer: "",
          aliases: [],
          source_file: analysis.path,
        },
        body: generatePolicyScaffold(analysis),
      });
      break;
    }

    default: {
      pages.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: sp.template || "tpl-answer.md",
        frontmatter: {
          title: sp.suggestedFilename,
          tags: [],
          date: today,
          status: "draft-pending-review",
          scope: analysis.keyInfo?.scope || "",
          reviewer: "",
          review_date: "",
          aliases: [],
        },
        body: generateDefaultScaffold(analysis),
      });
    }
  }

  return pages;
}

// ── Content generators ──

function generateFieldSpecContent(analysis) {
  const lines = [];
  lines.push(`# ${analysis.suggestedPlacement.suggestedFilename}`);
  lines.push("");
  lines.push(`来源：${analysis.filename}`);
  lines.push(`提取日期：${new Date().toISOString().slice(0, 10)}`);
  lines.push("");

  if (analysis.csvHeaders && analysis.csvHeaders.length > 0) {
    const headers = analysis.csvHeaders.filter((h) => h && h.trim());
    if (headers.length > 0) {
      lines.push("## 字段定义");
      lines.push("");
      lines.push(`| ${headers.map((h) => h || "—").join(" | ")} |`);
      lines.push(`| ${headers.map(() => "------").join(" | ")} |`);

      // Render all data rows as a flat table
      if (analysis.rawText) {
        const csvLines = analysis.rawText.split(/\r?\n/).filter(Boolean);
        const seen = new Set();

        for (let i = 0; i < csvLines.length; i++) {
          const vals = csvLines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((v) => v.trim().replace(/^"|"$/g, ""));
          const meaningful = vals.slice(0, headers.length);
          const nonEmptyCount = meaningful.filter((v) => v && v !== "—").length;

          // Skip rows matching the header pattern
          if (nonEmptyCount >= 2 && headers.some((h, idx) => h && meaningful[idx] === h)) continue;

          // Skip completely empty rows and single-column section titles
          if (nonEmptyCount <= 1) continue;

          const key = meaningful.join("|");
          if (key && !seen.has(key)) {
            seen.add(key);
            lines.push(`| ${meaningful.map((v) => v || "—").join(" | ")} |`);
          }
        }
      } else {
        lines.push(`| ${headers.map(() => "（待补充）").join(" | ")} |`);
      }
      lines.push("");
    }
  }

  lines.push("## 备注");
  lines.push("");
  lines.push("（待补充字段取值逻辑、码值映射、校验规则等详细信息）");
  lines.push("");

  return lines.join("\n");
}

function generateFeatureScaffold(analysis) {
  const lines = [];
  lines.push(`# ${analysis.suggestedPlacement.suggestedFilename}`);
  lines.push("");
  lines.push("此模块适用对象：（待确认）");
  lines.push("");
  lines.push("## 功能简介");
  lines.push("");
  if (analysis.summary) {
    lines.push(analysis.summary);
  } else {
    lines.push("（待补充：一句话说明该模块整体解决什么业务问题）");
  }
  lines.push("");
  lines.push("## 特性列表");
  lines.push("");
  lines.push("### 1.1 （特性名称）");
  lines.push("- 涉及平台：（待确认）");
  lines.push("- （特性描述：做了什么、影响什么）");
  lines.push("");
  lines.push("## 关联系统");
  lines.push("");
  lines.push("（待补充）");
  lines.push("");
  lines.push("## 关联操作指引");
  lines.push("");
  const guideName = analysis.suggestedPlacement.suggestedFilename.replace("特性说明", "操作指引");
  lines.push(`- [[${guideName}]]`);
  lines.push("");

  return lines.join("\n");
}

function generateGuideScaffold(analysis, featurePageName) {
  const lines = [];
  const guideName = featurePageName.replace("特性说明", "操作指引");
  lines.push(`# ${guideName}`);
  lines.push("");
  lines.push("此指引适用对象：（待确认）");
  lines.push("");
  lines.push("## 功能简介");
  lines.push("");
  lines.push("（待补充：一句话说明该功能做什么、解决什么问题）");
  lines.push("");
  lines.push("## 适用范围");
  lines.push("- 适用系统：（待确认）");
  lines.push("- 适用角色：（待确认）");
  lines.push("- 前置条件：（待补充）");
  lines.push("");
  lines.push("## 操作步骤");
  lines.push("");
  lines.push("1. （步骤1描述）");
  lines.push("   - 操作路径：（菜单/按钮路径）");
  lines.push("   - 预期结果：（操作后的页面/状态变化）");
  lines.push("");
  lines.push("## 注意事项");
  lines.push("");
  lines.push("- （容易误操作的点）");
  lines.push("- （权限限制）");
  lines.push("");
  lines.push("## 关联功能");
  lines.push("");
  lines.push(`- [[${featurePageName}]]`);
  lines.push("");

  return lines.join("\n");
}

function generatePolicyScaffold(analysis) {
  const lines = [];
  lines.push(`# ${analysis.suggestedPlacement.suggestedFilename}`);
  lines.push("");
  lines.push("## 白话要点");
  lines.push("");
  lines.push("（待补充：用日常语言重述核心内容）");
  lines.push("");
  lines.push("## 影响范围");
  lines.push("- 适用对象：（待确认）");
  lines.push("- 涉及流程：（待确认）");
  lines.push(`- 生效时间：（待确认）`);
  lines.push("注意：此数据有强时效性");
  lines.push("");
  lines.push("## 常见理解误区");
  lines.push("- 误区：→ 正解：");
  lines.push("");
  lines.push("## 与旧政策差异");
  lines.push("");
  lines.push("| 项目 | 旧规 | 新规 |");
  lines.push("|------|------|------|");
  lines.push("|      |      |      |");
  lines.push("");
  lines.push("## 关联标准解答");
  lines.push("");
  lines.push("（待补充）");
  lines.push("");

  return lines.join("\n");
}

function generateDefaultScaffold(analysis) {
  const lines = [];
  lines.push(`# ${analysis.suggestedPlacement.suggestedFilename}`);
  lines.push("");
  lines.push("此解答适用对象：（待确认）");
  lines.push("");
  lines.push("## 问题变体集");
  lines.push("- （待补充）");
  lines.push("");
  lines.push("## 标准解答");
  lines.push("");
  if (analysis.summary) {
    lines.push(analysis.summary);
  } else {
    lines.push("（待补充）");
  }
  lines.push("");
  lines.push("## 关联政策索引");
  lines.push("");
  lines.push("（待补充）");
  lines.push("");
  lines.push("## 常见追问");
  lines.push("");
  lines.push("- Q: → A:");
  lines.push("");

  return lines.join("\n");
}

// ── Helpers ──

function matterStringify(frontmatter, body) {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body;
  }
  let yaml = "---\n";
  for (const [key, value] of Object.entries(frontmatter)) {
    yaml += `${key}: ${formatYamlValue(value)}\n`;
  }
  yaml += "---\n\n";
  return yaml + body;
}

function formatYamlValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[" + value.map((v) => `"${v}"`).join(", ") + "]";
  }
  if (typeof value === "string") {
    if (value.includes(":") || value.includes("#") || value.includes("[") || value.includes("{")) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value || '""';
  }
  return String(value);
}

async function updateIndexMd(vaultPath, pages) {
  const indexPath = join(vaultPath, "wiki", "_index.md");
  let content;
  try {
    content = await readFile(indexPath, "utf-8");
  } catch {
    return; // silent — _index.md doesn't exist
  }

  const today = new Date().toISOString().slice(0, 10);
  let entry = `\n## ${today} ingest\n`;
  for (const page of pages) {
    // Use vault-relative path for wikilink so cross-directory links resolve correctly
    const vaultRel = join("", relative(vaultPath, page.path).replace(/\\/g, "/")).replace(/^\//, "");
    const linkTarget = vaultRel.replace(/\.md$/, "");
    entry += `- [[${linkTarget}]] — ${page.template}\n`;
  }

  await writeFile(indexPath, content + entry, "utf-8");
}

async function appendLogMd(vaultPath, sourceFile, pages) {
  const logPath = join(vaultPath, "wiki", "_log.md");
  const today = new Date().toISOString().slice(0, 10);
  const pageLinks = pages.map((p) => {
    // Use vault-relative path for wikilink so cross-directory links resolve correctly
    const vaultRel = join("", relative(vaultPath, p.path).replace(/\\/g, "/")).replace(/^\//, "");
    return `[[${vaultRel.replace(/\.md$/, "")}]]`;
  }).join(", ");

  const entry = `\n## [${today}] ingest | ${sourceFile} | ${pages.length} page(s)\n- Created: ${pageLinks}\n`;

  let content;
  try {
    content = await readFile(logPath, "utf-8");
  } catch {
    content = "# Audit Log\n";
  }

  await writeFile(logPath, content + entry, "utf-8");
}
