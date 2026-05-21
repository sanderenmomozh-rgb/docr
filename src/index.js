#!/usr/bin/env node
import { Command } from "commander";
import { scanDirectory } from "./scanner.js";
import { buildIndex } from "./indexer.js";
import { search } from "./search.js";
import { startServer } from "./server.js";
import { saveIndex, loadIndex, isCacheValid } from "./store.js";
import { getConfig, setConfig, getVaultPath } from "./config.js";

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

async function getOrBuildIndex(dir, opts = {}) {
  if (!opts.force && await isCacheValid(dir)) {
    const cached = await loadIndex(dir);
    if (cached) return cached;
  }
  const scanOpts = await getScanOpts(opts);
  const files = await scanDirectory(dir, scanOpts);
  const { index, bodies } = await buildIndex(files);
  await saveIndex(index, bodies, dir, files.length);
  return { index, bodies, fileCount: files.length };
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
          // Parse JSON values, but keep plain strings as-is
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
      const { index, fileCount } = await getOrBuildIndex(dir, opts);
      console.log(`Found ${fileCount} markdown files.`);
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
      const { index, bodies } = await getOrBuildIndex(dir, opts);
      console.log(`Indexed ${index.documentCount} documents.`);
      startServer(index, bodies, parseInt(opts.port));
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
