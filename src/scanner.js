import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";

/**
 * Walk a directory recursively and return all .md file paths.
 * @param {string} rootDir - Starting directory
 * @param {Object} [opts] - Options
 * @param {number} [opts.maxSize] - Skip files larger than this (bytes)
 */
export async function scanDirectory(rootDir, opts = {}) {
  const { maxSize, ignorePatterns = [] } = opts;
  const results = [];

  function shouldSkipDir(name) {
    if (name.startsWith(".")) return true;
    return ignorePatterns.includes(name);
  }

  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`Error reading directory ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !shouldSkipDir(entry.name)) {
        await walk(fullPath);
      } else if (entry.isFile() && extname(entry.name) === ".md") {
        try {
          const s = await stat(fullPath);
          if (maxSize != null && s.size > maxSize) continue;
          results.push({
            path: fullPath.replace(/\\/g, "/"),
            mtimeMs: s.mtimeMs,
            size: s.size,
          });
        } catch (err) {
          console.error(`Error reading file ${fullPath}: ${err.message}`);
        }
      }
    }
  }

  await walk(rootDir);
  return results;
}
