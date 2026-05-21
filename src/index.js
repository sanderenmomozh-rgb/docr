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

program.parse();
