#!/usr/bin/env node
import { Command } from "commander";
import { scanDirectory } from "./scanner.js";
import { buildIndex } from "./indexer.js";
import { search } from "./search.js";
import { startServer } from "./server.js";
import { saveIndex, loadIndex, isCacheValid } from "./store.js";
import { getConfig, setConfig, getVaultPath } from "./config.js";
import { computeTagStats } from "./analytics.js";
import { computeDashboard } from "./dashboard.js";
import { listInbox, confirmInbox, rejectInbox, detectType, summarizeInboxFile } from "./inbox.js";
import { analyzeSource } from "./analyze.js";
import { suggestLinks } from "./suggest.js";
import { previewImpact } from "./impact.js";
import { executeIngest } from "./ingest.js";

const program = new Command();

program
  .name("docr")
  .description("Organize and search your personal markdown notes")
  .version("1.0.0");

async function resolveDir(dir) {
  if (dir) return dir;
  return getVaultPath();
}

async function getScanOpts(opts) {
  const config = await getConfig();
  const scanOpts = { ignorePatterns: config.ignorePatterns };
  if (opts.maxSize) scanOpts.maxSize = parseInt(opts.maxSize);
  return scanOpts;
}

async function getFiles(dir, opts = {}) {
  const scanOpts = await getScanOpts(opts);
  return scanDirectory(dir, scanOpts);
}

async function getOrBuildIndex(dir, opts = {}) {
  if (!opts.force && await isCacheValid(dir)) {
    const cached = await loadIndex(dir);
    if (cached) {
      const files = await getFiles(dir, opts);
      return { ...cached, files };
    }
  }
  const files = await getFiles(dir, opts);
  const { index, bodies } = await buildIndex(files);
  await saveIndex(index, bodies, dir, files.length);
  return { index, bodies, files };
}

// ── config ──

program
  .command("config")
  .description("Manage docr configuration")
  .addCommand(
    new Command("get")
      .description("Show current configuration")
      .action(async () => {
        const config = await getConfig();
        console.log(JSON.stringify(config, null, 2));
      })
  )
  .addCommand(
    new Command("set")
      .description("Set a configuration value")
      .argument("<key>", "config key (vaultPath, port, ignorePatterns)")
      .argument("<value>", "config value")
      .action(async (key, value) => {
        try {
          let parsed = value;
          try { parsed = JSON.parse(value); } catch {}
          await setConfig(key, parsed);
          console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
        } catch (err) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }
      })
  );

// ── scan ──

program
  .command("scan")
  .description("Scan a directory and build the search index")
  .argument("[dir]", "directory containing markdown files (defaults to vault path)")
  .option("--max-size <bytes>", "skip files larger than this size")
  .option("--force", "rebuild index even if cache is valid")
  .action(async (dir, opts) => {
    try {
      dir = await resolveDir(dir);
      const { index, files } = await getOrBuildIndex(dir, opts);
      console.log(`Found ${files.length} markdown files.`);
      console.log(`Indexed ${index.documentCount} documents.`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── search ──

program
  .command("search")
  .description("Search indexed documents")
  .argument("<query>", "search query")
  .argument("[dir]", "directory (defaults to vault path)")
  .option("--max-size <bytes>", "skip files larger than this size")
  .option("--force", "rebuild index even if cache is valid")
  .action(async (query, dir, opts) => {
    try {
      dir = await resolveDir(dir);
      const { index, bodies } = await getOrBuildIndex(dir, opts);
      const results = search(index, bodies, query);

      if (results.length === 0) {
        console.log("No matches found.");
        return;
      }

      for (const r of results) {
        console.log(`\n── ${r.title} ──`);
        console.log(`   file : ${r.filename}`);
        if (r.tags.length) console.log(`   tags : ${r.tags.join(", ")}`);
        if (r.aliases && r.aliases.length) console.log(`   aliases : ${r.aliases.join(", ")}`);
        console.log(`   ${r.snippet}`);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── serve ──

program
  .command("serve")
  .description("Start the web search UI")
  .argument("[dir]", "directory containing markdown files (defaults to vault path)")
  .option("-p, --port <port>", "port to listen on", "3000")
  .option("--max-size <bytes>", "skip files larger than this size")
  .option("--force", "rebuild index even if cache is valid")
  .action(async (dir, opts) => {
    try {
      dir = await resolveDir(dir);
      const { index, bodies, files } = await getOrBuildIndex(dir, opts);
      console.log(`Indexed ${index.documentCount} documents.`);
      startServer(index, bodies, parseInt(opts.port), files);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── stats ──

program
  .command("stats")
  .description("Show vault statistics dashboard")
  .argument("[dir]", "directory (defaults to vault path)")
  .option("--json", "output as JSON")
  .option("--force", "rebuild index even if cache is valid")
  .action(async (dir, opts) => {
    try {
      dir = await resolveDir(dir);
      const { index, bodies, files } = await getOrBuildIndex(dir, opts);
      const dash = await computeDashboard(index, bodies, files);

      if (opts.json) {
        console.log(JSON.stringify(dash, null, 2));
        return;
      }

      console.log(`\n╔══════════════════════════════════╗`);
      console.log(`║       VAULT  STATISTICS         ║`);
      console.log(`╚══════════════════════════════════╝\n`);

      console.log(`📄 Notes:     ${dash.vault.totalNotes}`);
      console.log(`📝 Words:     ${dash.vault.totalWords.toLocaleString()} (avg ${dash.vault.avgWordsPerNote}/note)`);
      console.log(`💾 Size:      ${dash.vault.totalSizeKb} KB`);

      console.log(`\n── Tags ──`);
      console.log(`Unique: ${dash.tags.unique}  |  Untagged: ${dash.tags.untagged}`);
      if (dash.tags.mostUsed.length > 0) {
        console.log(`Top tags:`);
        for (const { tag, count } of dash.tags.mostUsed.slice(0, 5)) {
          console.log(`  ${tag} (${count})`);
        }
      }

      console.log(`\n── Links ──`);
      console.log(`Total: ${dash.links.totalLinks}`);
      console.log(`Orphans: ${dash.links.orphanCount}  |  Broken: ${dash.links.brokenLinkCount}  |  Dead ends: ${dash.links.deadEndCount}`);
      if (dash.links.mostLinked.length > 0) {
        console.log(`Most linked:`);
        for (const { path, incomingCount } of dash.links.mostLinked.slice(0, 3)) {
          const name = path.split("/").pop();
          console.log(`  ${name} ← ${incomingCount} incoming`);
        }
      }

      console.log();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── tags ──

program
  .command("tags")
  .description("List all tags with counts")
  .argument("[dir]", "directory (defaults to vault path)")
  .option("--json", "output as JSON")
  .action(async (dir, opts) => {
    try {
      dir = await resolveDir(dir);
      const { bodies } = await getOrBuildIndex(dir);
      const stats = computeTagStats(bodies);

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      if (stats.tagCounts.length === 0) {
        console.log("No tags found.");
        return;
      }

      for (const { tag, count } of stats.tagCounts) {
        const bar = "█".repeat(Math.max(1, count));
        console.log(`  ${tag.padEnd(20)} ${bar} ${count}`);
      }
      console.log(`\n${stats.totalUniqueTags} unique tags, ${stats.untaggedCount} untagged notes`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── orphans ──

program
  .command("orphans")
  .description("List orphaned notes (no incoming links)")
  .argument("[dir]", "directory (defaults to vault path)")
  .action(async (dir) => {
    try {
      dir = await resolveDir(dir);
      const { index, bodies, files } = await getOrBuildIndex(dir);

      const documents = [];
      for (const f of files) {
        const entry = bodies.get(f.path);
        documents.push({
          path: f.path,
          title: entry?.frontmatter?.title || f.path.split("/").pop().replace(".md", ""),
          tags: entry?.frontmatter?.tags || [],
          aliases: entry?.frontmatter?.aliases || [],
          body: entry?.body || "",
        });
      }

      const { buildLinkGraph } = await import("./wikilinks.js");
      const graph = buildLinkGraph(documents);

      if (graph.orphans.length === 0) {
        console.log("No orphaned notes — every note has at least one backlink.");
        return;
      }

      for (const path of graph.orphans) {
        const name = path.split("/").pop();
        console.log(`  ${name}`);
      }
      console.log(`\n${graph.orphans.length} orphaned note(s)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── broken-links ──

program
  .command("broken-links")
  .description("List broken wikilinks")
  .argument("[dir]", "directory (defaults to vault path)")
  .action(async (dir) => {
    try {
      dir = await resolveDir(dir);
      const { bodies, files } = await getOrBuildIndex(dir);

      const documents = [];
      for (const f of files) {
        const entry = bodies.get(f.path);
        documents.push({
          path: f.path,
          title: entry?.frontmatter?.title || f.path.split("/").pop().replace(".md", ""),
          tags: entry?.frontmatter?.tags || [],
          aliases: entry?.frontmatter?.aliases || [],
          body: entry?.body || "",
        });
      }

      const { buildLinkGraph } = await import("./wikilinks.js");
      const graph = buildLinkGraph(documents);

      if (graph.brokenLinks.length === 0) {
        console.log("No broken links — all [[wikilinks]] resolve to existing notes.");
        return;
      }

      for (const { source, target } of graph.brokenLinks) {
        const srcName = source.split("/").pop();
        console.log(`  ${srcName} → [[${target}]] (not found)`);
      }
      console.log(`\n${graph.brokenLinks.length} broken link(s)`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── backlinks ──

program
  .command("backlinks")
  .description("Show notes linking to a given title")
  .argument("<title>", "title or alias to find backlinks for")
  .argument("[dir]", "directory (defaults to vault path)")
  .action(async (title, dir) => {
    try {
      dir = await resolveDir(dir);
      const { bodies, files } = await getOrBuildIndex(dir);

      const documents = [];
      for (const f of files) {
        const entry = bodies.get(f.path);
        documents.push({
          path: f.path,
          title: entry?.frontmatter?.title || f.path.split("/").pop().replace(".md", ""),
          tags: entry?.frontmatter?.tags || [],
          aliases: entry?.frontmatter?.aliases || [],
          body: entry?.body || "",
        });
      }

      const { buildLinkGraph } = await import("./wikilinks.js");
      const graph = buildLinkGraph(documents);

      // Find the target path by title or alias
      const targetPath = documents.find(
        (d) =>
          d.title.toLowerCase() === title.toLowerCase() ||
          d.aliases.some((a) => a.toLowerCase() === title.toLowerCase())
      )?.path;

      const backlinks = targetPath ? graph.backlinks.get(targetPath) : undefined;

      if (!backlinks || backlinks.size === 0) {
        console.log(`No backlinks found for "${title}".`);
        return;
      }

      console.log(`\n${backlinks.size} note(s) link to "${title}":\n`);
      for (const src of backlinks) {
        const name = src.split("/").pop();
        console.log(`  ← ${name}`);
      }
      console.log();
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── inbox ──

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  program
    .command("inbox")
    .description("Manage 00_Inbox/ review queue")
    .addCommand(
      new Command("list")
        .description("List inbox items with review status")
        .option("--status <status>", "filter by status (pending|confirmed|rejected|all)", "all")
        .action(async (opts) => {
          try {
            const vaultPath = await getVaultPath();
            const items = await listInbox(vaultPath, opts.status);
            if (items.length === 0) {
              console.log("Inbox is empty.");
              return;
            }
            const statusLabel = { pending: "⏳", confirmed: "✅", rejected: "❌", ingested: "📦", archived: "📦" };
            for (const item of items) {
              const icon = statusLabel[item.status] || "  ";
              const typeLabel = item.type || detectType(item);
              console.log(`${icon} [${item.status.padEnd(9)}] ${item.ext.padEnd(6)} ${formatSize(item.size).padStart(8)}  ${item.filename}${typeLabel ? "  (" + typeLabel + ")" : ""}`);
            }
            console.log(`\n${items.length} item(s)`);
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command("scan")
        .description("Scan inbox for new files awaiting pre-review")
        .action(async () => {
          try {
            const vaultPath = await getVaultPath();
            const items = await listInbox(vaultPath, "pending");
            if (items.length === 0) {
              console.log("No new files awaiting pre-review.");
              return;
            }
            console.log(`Found ${items.length} file(s) awaiting pre-review:\n`);
            for (const item of items) {
              const typeLabel = item.type || detectType(item);
              console.log(`  ${item.filename}  (${typeLabel}, ${formatSize(item.size)})`);
            }
            console.log(`\n${items.length} file(s) pending. Use "docr inbox preview <file>" to review.`);
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command("preview")
        .description("Preview a structured summary of an inbox file")
        .argument("<file>", "filename in 00_Inbox/")
        .option("--format <format>", "output format (text|json)", "text")
        .action(async (file, opts) => {
          try {
            const vaultPath = await getVaultPath();
            const { join } = await import("node:path");
            const filePath = join(vaultPath, "00_Inbox", file);
            const summary = await summarizeInboxFile(filePath, vaultPath);
            if (opts.format === "json") {
              console.log(JSON.stringify(summary, null, 2));
              return;
            }
            console.log(`\n── ${summary.filename} ──`);
            console.log(`Type:       ${summary.type}`);
            console.log(`Format:     ${summary.format}`);
            console.log(`Words:      ${summary.wordCount}`);
            console.log(`Size:       ${(summary.size / 1024).toFixed(1)} KB`);
            if (summary.summary) console.log(`\nSummary:\n  ${summary.summary}`);
            const ki = summary.keyInfo;
            if (ki.scope) console.log(`\nScope:\n  ${ki.scope}`);
            if (ki.amounts.length) console.log(`\nAmounts:\n  ${ki.amounts.join(", ")}`);
            if (ki.dates.length) console.log(`\nDates:\n  ${ki.dates.join(", ")}`);
            if (ki.rates.length) console.log(`\nRates:\n  ${ki.rates.join(", ")}`);
            if (ki.hasTemporalFlag) console.log(`\n⚠  Contains time-sensitive data`);
            if (summary.images.length) console.log(`\nImages:    ${summary.images.length} reference(s)`);
            const sp = summary.suggestedPlacement;
            console.log(`\nSuggested placement:`);
            console.log(`  Directory:  ${sp.wikiDir}`);
            console.log(`  Filename:   ${sp.suggestedFilename}.md`);
            console.log(`  Template:   ${sp.template}`);
            console.log();
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command("admit")
        .description("Admit an inbox item to the knowledge base (alias for confirm)")
        .argument("<file>", "filename in 00_Inbox/")
        .option("--type <type>", "override content type classification")
        .option("--notes <notes>", "review notes")
        .action(async (file, opts) => {
          try {
            const vaultPath = await getVaultPath();
            const meta = {};
            if (opts.type) meta.type = opts.type;
            if (opts.notes) meta.notes = opts.notes;
            await confirmInbox(vaultPath, file, meta);
            console.log(`Admitted: ${file}`);
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command("confirm")
        .description("Confirm an inbox item for ingestion")
        .argument("<file>", "filename in 00_Inbox/")
        .option("--type <type>", "override content type classification")
        .option("--notes <notes>", "review notes")
        .action(async (file, opts) => {
          try {
            const vaultPath = await getVaultPath();
            const meta = {};
            if (opts.type) meta.type = opts.type;
            if (opts.notes) meta.notes = opts.notes;
            await confirmInbox(vaultPath, file, meta);
            console.log(`Confirmed: ${file}`);
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    )
    .addCommand(
      new Command("reject")
        .description("Reject an inbox item (skip ingestion)")
        .argument("<file>", "filename in 00_Inbox/")
        .option("--reason <reason>", "reason for rejection")
        .action(async (file, opts) => {
          try {
            const vaultPath = await getVaultPath();
            await rejectInbox(vaultPath, file, opts.reason || "");
            console.log(`Rejected: ${file}`);
          } catch (err) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
          }
        })
    );

// ── analyze ──

  program
    .command("analyze")
    .description("Analyze a confirmed inbox source")
    .argument("<source>", "filename in 00_Inbox/")
    .option("--format <format>", "output format (text|json)", "text")
    .action(async (source, opts) => {
      try {
        const vaultPath = await getVaultPath();
        const items = await listInbox(vaultPath, "confirmed");
        const item = items.find((i) => i.filename === source);
        if (!item) {
          console.error(`Error: "${source}" is not confirmed. Use "docr inbox confirm" first.`);
          process.exit(1);
        }
        const result = await analyzeSource(item.path, vaultPath);
        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`\n── ${result.filename} ──`);
        console.log(`Type:       ${result.type}`);
        console.log(`Format:     ${result.format}`);
        console.log(`Words:      ${result.wordCount}`);
        console.log(`Size:       ${(result.size / 1024).toFixed(1)} KB`);
        if (result.summary) console.log(`\nSummary:\n  ${result.summary}`);
        const ki = result.keyInfo;
        if (ki.scope) console.log(`\nScope:\n  ${ki.scope}`);
        if (ki.amounts.length) console.log(`\nAmounts:\n  ${ki.amounts.join(", ")}`);
        if (ki.dates.length) console.log(`\nDates:\n  ${ki.dates.join(", ")}`);
        if (ki.rates.length) console.log(`\nRates:\n  ${ki.rates.join(", ")}`);
        if (ki.hasTemporalFlag) console.log(`\n⚠  Contains time-sensitive data`);
        if (result.images.length) console.log(`\nImages:    ${result.images.length} reference(s)`);
        const sp = result.suggestedPlacement;
        console.log(`\nSuggested placement:`);
        console.log(`  Directory:  ${sp.wikiDir}`);
        console.log(`  Filename:   ${sp.suggestedFilename}.md`);
        console.log(`  Template:   ${sp.template}`);
        console.log();
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

// ── suggest-links ──

  program
    .command("suggest-links")
    .description("Suggest related wiki pages for a source")
    .argument("<source>", "filename in 00_Inbox/")
    .option("--max <n>", "max results", "10")
    .option("--format <format>", "output format (text|json)", "text")
    .action(async (source, opts) => {
      try {
        const vaultPath = await getVaultPath();
        const items = await listInbox(vaultPath, "confirmed");
        const item = items.find((i) => i.filename === source);
        if (!item) {
          console.error(`Error: "${source}" is not confirmed. Use "docr inbox confirm" first.`);
          process.exit(1);
        }
        // Analyze the source for query text
        const analysis = await analyzeSource(item.path, vaultPath);
        // Get the search index
        const { index, bodies } = await getOrBuildIndex(vaultPath);
        const suggestions = await suggestLinks(analysis, index, bodies, {
          maxResults: parseInt(opts.max),
        });

        if (opts.format === "json") {
          console.log(JSON.stringify(suggestions, null, 2));
          return;
        }

        if (suggestions.length === 0) {
          console.log("No related wiki pages found.");
          return;
        }

        console.log(`\nRelated pages for "${source}":\n`);
        for (const s of suggestions) {
          const name = s.path.split("/").pop();
          console.log(`  ${s.score.toFixed(2)}  ${s.title}`);
          console.log(`          ${name}${s.tagOverlap.length ? "  tags: " + s.tagOverlap.join(", ") : ""}`);
          if (s.snippet) console.log(`          ${s.snippet.slice(0, 100)}`);
        }
        console.log();
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

// ── impact ──

  program
    .command("impact")
    .description("Preview what pages would be created/updated by ingesting a source")
    .argument("<source>", "filename in 00_Inbox/")
    .option("--format <format>", "output format (text|json)", "text")
    .action(async (source, opts) => {
      try {
        const vaultPath = await getVaultPath();
        const items = await listInbox(vaultPath, "confirmed");
        const item = items.find((i) => i.filename === source);
        if (!item) {
          console.error(`Error: "${source}" is not confirmed. Use "docr inbox confirm" first.`);
          process.exit(1);
        }
        const analysis = await analyzeSource(item.path, vaultPath);
        const { index, bodies } = await getOrBuildIndex(vaultPath);
        const suggestions = await suggestLinks(analysis, index, bodies);
        const impact = await previewImpact(analysis, suggestions, vaultPath);

        if (opts.format === "json") {
          console.log(JSON.stringify(impact, null, 2));
          return;
        }

        console.log(`\n╔══════════════════════════════════════╗`);
        console.log(`║       INGEST  IMPACT  PREVIEW       ║`);
        console.log(`╚══════════════════════════════════════╝\n`);
        console.log(`Source:  ${impact.source}`);
        console.log(`Type:    ${impact.type}`);
        console.log(`Words:   ${impact.wordCount}`);
        if (impact.imageCount) console.log(`Images:  ${impact.imageCount}`);
        if (impact.hasTemporalData) console.log(`⚠  Contains time-sensitive data`);

        if (impact.wouldCreate.length > 0) {
          console.log(`\n── Would CREATE (${impact.wouldCreate.length} page(s)) ──`);
          for (const c of impact.wouldCreate) {
            console.log(`\n  📄 ${c.title}`);
            console.log(`     Path:     ${c.path}`);
            console.log(`     Template: ${c.template}`);
            console.log(`     Reason:   ${c.reason}`);
          }
        }

        if (impact.wouldUpdate.length > 0) {
          console.log(`\n── Would UPDATE (${impact.wouldUpdate.length} page(s)) ──`);
          for (const u of impact.wouldUpdate.slice(0, 10)) {
            const name = u.path.split("/").pop();
            console.log(`\n  ✏  ${u.title}`);
            console.log(`     ${name}`);
            for (const c of u.changes) {
              console.log(`     - ${c}`);
            }
          }
          if (impact.wouldUpdate.length > 10) {
            console.log(`\n  ... and ${impact.wouldUpdate.length - 10} more`);
          }
        }

        if (impact.affectedEntityPages.length > 0) {
          console.log(`\n── Affected Entity Pages (${impact.affectedEntityPages.length}) ──`);
          for (const p of impact.affectedEntityPages) {
            console.log(`  🏷  ${p.split("/").pop()}`);
          }
        }

        console.log(`\nEstimated: ${impact.estimatedPageCount} new page(s), ${impact.wouldUpdate.length} existing page(s) updated`);
        console.log();
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

// ── ingest ──

  program
    .command("ingest")
    .description("Execute ingest: create wiki pages from a confirmed inbox source")
    .argument("<source>", "filename in 00_Inbox/")
    .option("--dry-run", "preview only, do not write files")
    .option("--force", "overwrite existing pages")
    .option("--format <format>", "output format (text|json)", "text")
    .action(async (source, opts) => {
      try {
        const vaultPath = await getVaultPath();
        const { join } = await import("node:path");
        const filePath = join(vaultPath, "00_Inbox", source);

        const items = await listInbox(vaultPath, "confirmed");
        const item = items.find((i) => i.filename === source);
        if (!item) {
          console.error(`Error: "${source}" is not confirmed. Use "docr inbox confirm" first.`);
          process.exit(1);
        }

        const { index, bodies } = await getOrBuildIndex(vaultPath);
        const result = await executeIngest(filePath, vaultPath, index, bodies, {
          dryRun: opts.dryRun || false,
          force: opts.force || false,
        });

        if (result.skipped) {
          console.log(`\n⚠  Skipped: ${result.reason}`);
          if (result.duplicates && result.duplicates.length > 0) {
            console.log();
            for (const dup of result.duplicates) {
              console.log(`  ${dup.path}`);
              for (const reason of dup.reasons) {
                console.log(`    ↳ ${reason}`);
              }
              console.log();
            }
            console.log(`Use --force to ingest anyway, or review the existing files first.`);
          }
          return;
        }

        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.dryRun) {
          console.log(`\n╔══════════════════════════════════════╗`);
          console.log(`║       INGEST  DRY  RUN               ║`);
          console.log(`╚══════════════════════════════════════╝\n`);
        } else {
          console.log(`\n╔══════════════════════════════════════╗`);
          console.log(`║       INGEST  COMPLETE               ║`);
          console.log(`╚══════════════════════════════════════╝\n`);
        }

        console.log(`Source:  ${result.source}`);
        console.log(`Type:    ${result.type}`);
        if (result.archivedPath) {
          console.log(`Archive: ${result.archivedPath}`);
        } else if (result.wouldArchive) {
          console.log(`Archive: ${result.wouldArchive}  (dry-run)`);
        }

        if (result.created.length > 0) {
          console.log(`\n── Created (${result.created.length} page(s)) ──`);
          for (const c of result.created) {
            const name = c.path.split("/").pop();
            console.log(`\n  ${result.dryRun ? '📄' : '✅'} ${c.title}`);
            console.log(`     ${c.path}`);
            console.log(`     Template: ${c.template}`);
            if (result.dryRun) {
              console.log(`     Preview: ${c.body ? c.body.slice(0, 120) : '(scaffold)'}`);
            }
          }
        }

        if (result.updated && result.updated.length > 0) {
          console.log(`\n── Would Update (${result.updated.length} page(s)) ──`);
          for (const u of result.updated.slice(0, 5)) {
            const name = u.path.split("/").pop();
            console.log(`  ✏  ${name}: ${u.changes.join(", ")}`);
          }
          if (result.updated.length > 5) {
            console.log(`  ... and ${result.updated.length - 5} more`);
          }
        }

        if (result.duplicates && result.duplicates.length > 0) {
          console.log(`\n── ⚠ Potential Duplicates (${result.duplicates.length}) ──`);
          for (const dup of result.duplicates) {
            console.log(`\n  ${dup.path}`);
            for (const reason of dup.reasons) {
              console.log(`    ↳ ${reason}`);
            }
          }
          console.log(`\n  Use --force to ingest anyway.`);
        }

        if (result.dryRun) {
          console.log(`\nDry run complete. No files were changed.`);
          console.log(`Use without --dry-run to execute.`);
        }

        console.log();
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });

  program.parse();
