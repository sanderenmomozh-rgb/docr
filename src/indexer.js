import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import MiniSearch from "minisearch";

function normalizeTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") return [tags];
  return [];
}

function normalizeAliases(aliases) {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases;
  if (typeof aliases === "string") return [aliases];
  return [];
}

/**
 * Build a search index from a list of { path, mtimeMs, size } entries.
 * Each .md file is parsed for YAML frontmatter.
 */
export async function buildIndex(fileEntries) {
  const documents = [];

  for (const entry of fileEntries) {
    try {
      const raw = await readFile(entry.path, "utf-8");
      const { data, content } = matter(raw);

      const title = data.title || basename(entry.path, ".md");
      const tags = normalizeTags(data.tags);
      const aliases = normalizeAliases(data.aliases);
      const date = data.date || data.created || null;

      documents.push({
        id: entry.path,
        path: entry.path,
        filename: basename(entry.path),
        title,
        tags,
        aliases,
        date,
        modified: data.modified || null,
        body: content,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      });
    } catch (err) {
      console.error(`Error indexing ${entry.path}: ${err.message}`);
    }
  }

  const miniSearch = new MiniSearch({
    fields: ["title", "aliases", "tags", "body"],
    storeFields: [
      "path", "filename", "title", "tags", "aliases", "date",
      "modified", "mtimeMs",
    ],
    searchOptions: {
      boost: { title: 3, aliases: 2, tags: 2, body: 1 },
      prefix: true,
    },
  });

  miniSearch.addAll(documents);

  const bodies = new Map(
    documents.map((d) => [d.path, { body: d.body, frontmatter: { title: d.title, tags: d.tags, aliases: d.aliases, date: d.date, modified: d.modified } }])
  );

  return { index: miniSearch, bodies };
}
