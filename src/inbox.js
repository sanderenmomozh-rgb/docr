import { readdir, stat, readFile, writeFile, rename } from "node:fs/promises";
import { join, extname } from "node:path";
import { analyzeSource } from "./analyze.js";

const STATE_FILENAME = ".docr-inbox-state.json";

// ── File scanning ──

export async function scanInbox(vaultPath) {
  const inboxDir = join(vaultPath, "00_Inbox");
  const results = [];

  let entries;
  try {
    entries = await readdir(inboxDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(inboxDir, entry.name);
    try {
      const s = await stat(fullPath);
      results.push({
        filename: entry.name,
        path: fullPath.replace(/\\/g, "/"),
        ext: extname(entry.name).toLowerCase(),
        size: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // skip files we can't stat
    }
  }

  results.sort((a, b) => a.filename.localeCompare(b.filename, "zh"));
  return results;
}

// ── State management ──

export async function loadInboxState(vaultPath) {
  const statePath = join(vaultPath, STATE_FILENAME);
  try {
    const raw = await readFile(statePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { version: 1, items: {} };
  }
}

export async function saveInboxState(vaultPath, state) {
  const statePath = join(vaultPath, STATE_FILENAME);
  const tmpPath = statePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmpPath, statePath);
}

// ── Unified view ──

export async function listInbox(vaultPath, filter = "all") {
  const [files, state] = await Promise.all([
    scanInbox(vaultPath),
    loadInboxState(vaultPath),
  ]);

  const currentFilenames = new Set(files.map((f) => f.filename));

  // Prune stale entries
  let pruned = false;
  for (const key of Object.keys(state.items)) {
    if (!currentFilenames.has(key)) {
      delete state.items[key];
      pruned = true;
    }
  }

  const results = files.map((f) => {
    const entry = state.items[f.filename] || { status: "pending" };
    return {
      ...f,
      status: entry.status || "pending",
      confirmedAt: entry.confirmedAt || null,
      rejectedAt: entry.rejectedAt || null,
      reason: entry.reason || null,
      confirmedBy: entry.confirmedBy || null,
      type: entry.type || null,
      notes: entry.notes || null,
    };
  });

  if (pruned) {
    const newState = { version: state.version, items: {} };
    for (const r of results) {
      newState.items[r.filename] = {
        status: r.status,
        confirmedAt: r.confirmedAt,
        rejectedAt: r.rejectedAt,
        reason: r.reason,
        confirmedBy: r.confirmedBy,
        type: r.type,
        notes: r.notes,
      };
    }
    await saveInboxState(vaultPath, newState);
  }

  if (filter === "all") return results;
  return results.filter((r) => r.status === filter);
}

// ── Confirm / Reject ──

export async function confirmInbox(vaultPath, filename, meta = {}) {
  const state = await loadInboxState(vaultPath);
  const now = new Date().toISOString();

  state.items[filename] = {
    status: "confirmed",
    confirmedAt: now,
    rejectedAt: null,
    reason: null,
    confirmedBy: meta.confirmedBy || "Sande",
    type: meta.type || null,
    notes: meta.notes || null,
  };

  await saveInboxState(vaultPath, state);
}

export async function rejectInbox(vaultPath, filename, reason, rejectedBy) {
  const state = await loadInboxState(vaultPath);
  const now = new Date().toISOString();

  state.items[filename] = {
    status: "rejected",
    confirmedAt: null,
    rejectedAt: now,
    reason: reason || "",
    confirmedBy: null,
    type: state.items[filename]?.type || null,
    notes: state.items[filename]?.notes || null,
  };

  await saveInboxState(vaultPath, state);
}

export async function markIngested(vaultPath, filename) {
  const state = await loadInboxState(vaultPath);
  const now = new Date().toISOString();

  state.items[filename] = {
    ...state.items[filename],
    status: "ingested",
    ingestedAt: now,
  };

  await saveInboxState(vaultPath, state);
}

// ── Type detection ──

export function detectType(file, contentSample = null) {
  const name = file.filename.toLowerCase();
  const ext = file.ext;

  // FAQ CSV — filename or content hints
  if (ext === ".csv" && (name.includes("faq") || name.includes("问答") || name.includes("标准版"))) {
    return "faq-csv";
  }

  // Field mapping CSVs (工单信息集)
  if (ext === ".csv" && (name.includes("工单") || name.includes("字段"))) {
    return "field-spec";
  }

  // Generic CSV
  if (ext === ".csv") return "faq-csv";

  // System spec DOCX
  if (ext === ".docx" && (name.includes("ssc") || name.includes("系统") || name.includes("流程") || name.includes("需求") || name.includes("spec"))) {
    return "system-spec";
  }

  // Generic DOCX
  if (ext === ".docx") return "system-spec";

  // MD files — check content for hints
  if (ext === ".md") {
    if (name.includes("plan") || name.includes("方案") || name.includes("规划")) return "planning-doc";
    if (name.includes("纪要") || name.includes("meeting") || name.includes("会议")) return "meeting-notes";
    if (name.includes("周报") || name.includes("weekly") || name.includes("双周")) return "weekly-report";
    if (name.includes("政策") || name.includes("policy") || name.includes("制度") || name.includes("规范")) return "policy-doc";
    // Pandoc reference files
    if (name.includes("pandoc")) return "conversion-ref";
    if (name.includes("ssc") || name.includes("咨询服务")) return "system-spec";
    return "note";
  }

  // Images
  if ([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"].includes(ext)) return "screenshot";

  // PDF
  if (ext === ".pdf") return "policy-doc";

  return "unknown";
}

// ── File preview ──

export async function previewInboxFile(filePath) {
  const ext = extname(filePath).toLowerCase();

  try {
    if (ext === ".md" || ext === ".txt") {
      const content = await readFile(filePath, "utf-8");
      return { preview: content.slice(0, 5000), type: "text", raw: content };
    }

    if (ext === ".csv") {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      const headers = lines[0] || "";
      const previewLines = lines.slice(0, 50).join("\n");
      return {
        preview: previewLines.slice(0, 5000),
        type: "csv",
        raw: content,
        headers: headers.split(",").map((h) => h.trim().replace(/^"|"$/g, "")),
        totalRows: lines.length - 1,
      };
    }

    if (ext === ".docx") {
      try {
        const { extractRawText } = await import("mammoth");
        const buffer = await readFile(filePath);
        const result = await extractRawText({ buffer });
        return {
          preview: result.value.slice(0, 5000),
          type: "text",
          raw: result.value,
        };
      } catch {
        return { preview: null, type: "binary", raw: null, error: "mammoth extraction failed" };
      }
    }

    // Binary or unknown — metadata only
    const s = await stat(filePath);
    return { preview: null, type: "binary", raw: null, size: s.size };
  } catch (err) {
    return { preview: null, type: "error", raw: null, error: err.message };
  }
}

// ── Smart summary for pre-review ──

export async function summarizeInboxFile(filePath, vaultPath) {
  const analysis = await analyzeSource(filePath, vaultPath);
  return {
    filename: analysis.filename,
    type: analysis.type,
    format: analysis.format,
    wordCount: analysis.wordCount,
    size: analysis.size,
    summary: analysis.summary,
    keyInfo: analysis.keyInfo,
    suggestedPlacement: analysis.suggestedPlacement,
    images: analysis.images,
  };
}
