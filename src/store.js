import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import MiniSearch from "minisearch";

const CACHE_DIR = ".docr-cache";
const INDEX_FILE = "index.json";
const BODIES_FILE = "bodies.json";
const META_FILE = "meta.json";

/**
 * Save index, bodies Map, and metadata to a .docr-cache directory.
 */
export async function saveIndex(index, bodies, dir, fileCount) {
  const cacheDir = join(dir, CACHE_DIR);
  await mkdir(cacheDir, { recursive: true });

  const indexJson = JSON.stringify(index.toJSON());
  const bodiesJson = JSON.stringify([...bodies]);
  const meta = { documentCount: index.documentCount, fileCount, indexVersion: 1 };

  await Promise.all([
    writeFile(join(cacheDir, INDEX_FILE), indexJson, "utf-8"),
    writeFile(join(cacheDir, BODIES_FILE), bodiesJson, "utf-8"),
    writeFile(join(cacheDir, META_FILE), JSON.stringify(meta), "utf-8"),
  ]);
}

/**
 * Load a previously saved index+bodies from cache. Returns null on any failure.
 */
export async function loadIndex(dir) {
  try {
    const cacheDir = join(dir, CACHE_DIR);
    const [indexJson, bodiesJson, metaRaw] = await Promise.all([
      readFile(join(cacheDir, INDEX_FILE), "utf-8"),
      readFile(join(cacheDir, BODIES_FILE), "utf-8"),
      readFile(join(cacheDir, META_FILE), "utf-8"),
    ]);

    const { tokenize } = await import("./indexer.js");
    const index = MiniSearch.loadJSON(indexJson, {
      fields: ["title", "aliases", "tags", "body"],
      storeFields: ["path", "filename", "title", "tags", "aliases", "date", "mtimeMs"],
      tokenize,
      searchOptions: {
        boost: { title: 3, aliases: 2, tags: 2, body: 1 },
        prefix: true,
      },
    });

    const bodies = new Map(JSON.parse(bodiesJson));
    const meta = JSON.parse(metaRaw);
    return { index, bodies, fileCount: meta.fileCount };
  } catch {
    return null;
  }
}

/**
 * Check whether the cache is stale — i.e., any .md file has a newer mtime
 * than the cache was written, or the file count changed.
 */
export async function isCacheValid(dir) {
  try {
    const cacheDir = join(dir, CACHE_DIR);
    const metaRaw = await readFile(join(cacheDir, META_FILE), "utf-8");
    const meta = JSON.parse(metaRaw);

    const files = [];
    async function walk(d) {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          await walk(join(d, e.name));
        } else if (e.isFile() && e.name.endsWith(".md")) {
          const s = await stat(join(d, e.name));
          files.push({ mtimeMs: s.mtimeMs });
        }
      }
    }
    await walk(dir);

    if (files.length !== meta.documentCount) return false;

    const newestMtime = Math.max(...files.map((f) => f.mtimeMs));
    const cacheFiles = await Promise.all([
      stat(join(cacheDir, INDEX_FILE)),
      stat(join(cacheDir, META_FILE)),
    ]);
    const cacheAge = Math.min(...cacheFiles.map((s) => s.mtimeMs));

    return newestMtime <= cacheAge;
  } catch {
    return false;
  }
}
