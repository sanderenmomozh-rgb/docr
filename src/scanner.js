import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

/**
 * Walk a directory recursively and return all .md file paths.
 */
export async function scanDirectory(rootDir) {
  const results = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        const s = await stat(fullPath);
        results.push({ path: fullPath, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  }

  await walk(rootDir);
  return results;
}
