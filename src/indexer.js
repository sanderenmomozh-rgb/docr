import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import MiniSearch from "minisearch";

/**
 * Build a search index from a list of { path, mtimeMs, size } entries.
 * Each .md file is parsed for YAML frontmatter (title, tags, date).
 * The body is stored for full-text search; frontmatter fields are
 * indexed as separate searchable fields.
 */
export async function buildIndex(fileEntries) {
  const documents = [];

  for (const entry of fileEntries) {
    try {
      const raw = await readFile(entry.path, "utf-8");
      const { data, content } = matter(raw);

      documents.push({
        id: entry.path,
        path: entry.path,
        filename: basename(entry.path),
        title: data.title || basename(entry.path, ".md"),
        tags: data.tags || [],
        date: data.date || null,
        body: content,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      });
    } catch (err) {
      console.error(`Error indexing ${entry.path}: ${err.message}`);
    }
  }

  const miniSearch = new MiniSearch({
    fields: ["title", "tags", "body"],
    storeFields: ["path", "filename", "title", "tags", "date", "mtimeMs"],
    searchOptions: {
      boost: { title: 3, tags: 2, body: 1 },
      prefix: true,
    },
  });

  miniSearch.addAll(documents);

  const bodies = new Map(documents.map((d) => [d.path, d.body]));

  return { index: miniSearch, bodies };
}
