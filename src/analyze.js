import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Analyze a confirmed inbox source file.
 * @param {string} filePath - full path to the source file
 * @param {string} vaultPath - vault root path
 * @param {object} [opts]
 * @returns {Promise<object>} AnalysisResult
 */
export async function analyzeSource(filePath, vaultPath, opts = {}) {
  const filename = filePath.replace(/\\/g, "/").split("/").pop();
  const { text, format, images } = await readSource(filePath);
  const type = classifyType(filename, text, format);
  const summary = generateSummary(text, format, type);
  const keyInfo = extractKeyInfo(text, type);
  const suggestedPlacement = suggestPlacement(type, filename, vaultPath);

  const s = await stat(filePath).catch(() => ({ size: 0 }));

  return {
    filename,
    path: filePath.replace(/\\/g, "/"),
    type,
    format,
    summary,
    keyInfo,
    suggestedPlacement,
    wordCount: text ? countWords(text) : 0,
    size: s.size,
    images,
  };
}

// ── Source reading ──

async function readSource(filePath) {
  const name = filePath.toLowerCase();

  if (name.endsWith(".md") || name.endsWith(".txt")) {
    const text = await readFile(filePath, "utf-8");
    return { text, format: "markdown", images: extractImageRefs(text) };
  }

  if (name.endsWith(".csv")) {
    const text = await readFile(filePath, "utf-8");
    const firstLine = text.split(/\r?\n/)[0] || "";
    return { text, format: "csv", images: [], csvHeaders: parseCsvHeaders(firstLine) };
  }

  if (name.endsWith(".docx")) {
    try {
      const { extractRawText } = await import("mammoth");
      const buf = await readFile(filePath);
      const result = await extractRawText({ buffer: buf });
      const images = extractImageRefs(result.value);
      return { text: result.value, format: "docx", images };
    } catch {
      return { text: "", format: "docx", images: [], error: "mammoth failed" };
    }
  }

  return { text: "", format: "unknown", images: [] };
}

function extractImageRefs(text) {
  // match ![alt](path) and ![[path]]
  const refs = [];
  const mdImg = /!\[[^\]]*\]\(([^)]+)\)/g;
  const wikiImg = /!\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = mdImg.exec(text))) refs.push(m[1]);
  while ((m = wikiImg.exec(text))) refs.push(m[1]);
  return [...new Set(refs)];
}

function parseCsvHeaders(line) {
  return line.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
}

// ── Classification ──

function classifyType(filename, text, format) {
  const name = filename.toLowerCase();

  if (format === "csv") {
    const firstLine = text.split(/\r?\n/)[0] || "";
    const headers = parseCsvHeaders(firstLine);
    if (isRagFlowCsv(headers)) return "faq-csv";
    if (headers.some((h) => h.includes("工单") || h.includes("字段"))) return "field-spec";
    return "faq-csv";
  }

  if (format === "docx") {
    if (name.includes("ssc") || name.includes("系统") || name.includes("流程")) return "system-spec";
    if (name.includes("政策") || name.includes("制度")) return "policy-doc";
    return "system-spec";
  }

  // Markdown
  if (name.includes("plan") || name.includes("方案")) return "planning-doc";
  if (name.includes("纪要") || name.includes("meeting") || name.includes("会议")) return "meeting-notes";
  if (name.includes("周报") || name.includes("weekly")) return "weekly-report";
  if (name.includes("政策") || name.includes("policy")) return "policy-doc";
  if (name.includes("pandoc")) return "conversion-ref";
  if (name.includes("ssc") || name.includes("咨询")) return "system-spec";

  return "note";
}

function isRagFlowCsv(headers) {
  const h = headers.map((x) => x.toLowerCase());
  const ragFields = ["问题", "答案", "chunkid", "一级分类", "二级分类"];
  return ragFields.filter((f) => h.some((x) => x.includes(f))).length >= 2;
}

// ── Key info extraction ──

function extractKeyInfo(text, type) {
  const scope = extractScope(text, type);
  const amounts = extractAmounts(text);
  const dates = extractDates(text);
  const hasTemporalFlag =
    /时效|有效期|截止|到期|期限|注意：此数据/.test(text) ||
    amounts.length > 0 ||
    /\d+%/.test(text);

  return { scope, amounts, dates, rates: extractRates(text), hasTemporalFlag };
}

function extractScope(text, _type) {
  // Look for scope keywords
  const patterns = [
    /适[用应][对范][象围][：:]\s*([^\n]{2,50})/g,
    /适用范围[：:]\s*([^\n]{2,50})/g,
    /适用平台[：:]\s*([^\n]{2,100})/g,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) found.push(m[1].trim());
  }
  return found.length ? [...new Set(found)].join("；") : null;
}

function extractAmounts(text) {
  // Chinese monetary amounts
  const patterns = [
    /\d+[\d,]*\.?\d*\s*[元块]/g,
    /\d+[\d,]*\.?\d*\s*万[元块]?/g,
    /[¥￥]\s*\d+[\d,]*\.?\d*/g,
  ];
  const found = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) found.push(m[0]);
  }
  return [...new Set(found)].slice(0, 20);
}

function extractDates(text) {
  const re = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) found.push(m[0]);
  return [...new Set(found)].slice(0, 10);
}

function extractRates(text) {
  const re = /\d+\.?\d*\s*%/g;
  const found = [];
  let m;
  while ((m = re.exec(text))) found.push(m[0]);
  return [...new Set(found)].slice(0, 10);
}

// ── Placement suggestion ──

function suggestPlacement(type, filename, vaultPath) {
  const base = filename.replace(/\.[^.]+$/, "");
  const wikiDir = join(vaultPath, "wiki");

  switch (type) {
    case "faq-csv":
      return {
        wikiDir: join(wikiDir, "answers").replace(/\\/g, "/"),
        suggestedFilename: `${base} - 标准解答`,
        template: "tpl-answer.md",
      };
    case "field-spec":
    case "system-spec":
      return {
        wikiDir: join(wikiDir, "features").replace(/\\/g, "/"),
        suggestedFilename: `${base} - 特性说明`,
        template: "tpl-feature.md",
      };
    case "policy-doc":
      return {
        wikiDir: join(wikiDir, "policies").replace(/\\/g, "/"),
        suggestedFilename: `${base} - 解读`,
        template: "tpl-policy.md",
      };
    case "meeting-notes":
    case "weekly-report":
      return {
        wikiDir: join(wikiDir, "answers").replace(/\\/g, "/"),
        suggestedFilename: `${base}`,
        template: "tpl-answer.md",
      };
    default:
      return {
        wikiDir: join(wikiDir, "answers").replace(/\\/g, "/"),
        suggestedFilename: base,
        template: "tpl-answer.md",
      };
  }
}

// ── Helpers ──

function generateSummary(text, format, type) {
  if (!text) return "(empty)";

  if (format === "csv") {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = parseCsvHeaders(lines[0] || "");
    if (isRagFlowCsv(headers)) {
      // Count unique categories
      const catIdx = headers.findIndex((h) => h.includes("分类"));
      const cats = new Set();
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
        if (catIdx >= 0 && vals[catIdx]) cats.add(vals[catIdx].trim());
      }
      return `FAQ dataset with ${lines.length - 1} rows across ${cats.size} categories`;
    }
    return `CSV with ${lines.length - 1} rows, columns: ${headers.slice(0, 5).join(", ")}${headers.length > 5 ? "..." : ""}`;
  }

  if (type === "conversion-ref") {
    return `Pandoc conversion reference file with images`;
  }

  // For markdown/docx: find first meaningful paragraph
  const lines = text
    .replace(/^---[\s\S]*?---/, "") // strip frontmatter
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("|"));

  const firstText = lines.find((l) => l.length > 20);
  if (firstText) {
    return firstText.length > 200 ? firstText.slice(0, 200) + "..." : firstText;
  }

  return `Document with ${text.length} characters`;
}

function countWords(text) {
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const ascii = (text.match(/[a-zA-Z0-9]+/g) || []).length;
  return cjk + ascii;
}
