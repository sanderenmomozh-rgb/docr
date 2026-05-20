#!/usr/bin/env node
import { Command } from "commander";
import { scanDirectory } from "./scanner.js";
import { buildIndex } from "./indexer.js";
import { search } from "./search.js";
import { startServer } from "./server.js";

const program = new Command();

program
  .name("docr")
  .description("Organize and search your personal markdown notes")
  .version("1.0.0");

program
  .command("scan")
  .description("Scan a directory and build the search index")
  .argument("<dir>", "directory containing markdown files")
  .action(async (dir) => {
    console.log(`Scanning ${dir}...`);
    const files = await scanDirectory(dir);
    console.log(`Found ${files.length} markdown files.`);

    const { index } = await buildIndex(files);
    console.log(`Indexed ${index.documentCount} documents.`);
  });

program
  .command("search")
  .description("Search indexed documents")
  .argument("<dir>", "directory containing markdown files")
  .argument("<query>", "search query")
  .action(async (dir, query) => {
    const files = await scanDirectory(dir);
    const { index, bodies } = await buildIndex(files);
    const results = search(index, bodies, query);

    if (results.length === 0) {
      console.log("No matches found.");
      return;
    }

    for (const r of results) {
      console.log(`\n── ${r.title} ──`);
      console.log(`   file : ${r.filename}`);
      if (r.tags.length) console.log(`   tags : ${r.tags.join(", ")}`);
      console.log(`   ${r.snippet}`);
    }
  });

program
  .command("serve")
  .description("Start the web search UI")
  .argument("<dir>", "directory containing markdown files")
  .option("-p, --port <port>", "port to listen on", "3000")
  .action(async (dir, opts) => {
    const files = await scanDirectory(dir);
    const { index, bodies } = await buildIndex(files);
    console.log(`Indexed ${index.documentCount} documents.`);
    startServer(index, bodies, parseInt(opts.port));
  });

program.parse();
