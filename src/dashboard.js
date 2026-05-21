import { computeTagStats } from "./analytics.js";
import { buildLinkGraph } from "./wikilinks.js";

/**
 * Build a full vault dashboard from scanned files and indexed data.
 */
export async function computeDashboard(index, bodies, files) {
  // Build documents list from files + bodies Map
  const documents = [];
  for (const f of files) {
    const entry = bodies.get(f.path) || { body: "", frontmatter: {} };
    documents.push({
      path: f.path,
      title: entry.frontmatter.title || f.path,
      tags: entry.frontmatter.tags || [],
      aliases: entry.frontmatter.aliases || [],
      body: entry.body || "",
      mtimeMs: f.mtimeMs,
      size: f.size,
    });
  }

  const tags = computeTagStats(bodies);
  const graph = buildLinkGraph(documents);

  // Size stats
  const totalSizeKb = Math.round(
    files.reduce((sum, f) => sum + f.size, 0) / 1024
  );

  // Word count
  let totalWords = 0;
  for (const doc of documents) {
    totalWords += (doc.body.match(/[\w一-鿿]+/g) || []).length;
  }
  const avgWordsPerNote = documents.length > 0
    ? Math.round(totalWords / documents.length)
    : 0;

  // Date stats
  const sortedByMtime = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newestFile = sortedByMtime[0] || null;
  const oldestFile = sortedByMtime[sortedByMtime.length - 1] || null;

  // Most linked notes
  const mostLinked = [...graph.backlinks.entries()]
    .map(([path, sources]) => ({
      path,
      incomingCount: sources.size,
    }))
    .sort((a, b) => b.incomingCount - a.incomingCount)
    .slice(0, 10);

  // Dead ends (no outgoing links)
  const deadEnds = documents
    .filter((d) => {
      const outgoing = graph.forwardLinks.get(d.path);
      return !outgoing || outgoing.size === 0;
    })
    .map((d) => d.path);

  return {
    vault: {
      totalNotes: documents.length,
      totalWords,
      avgWordsPerNote,
      totalSizeKb,
      newestNote: newestFile
        ? { path: newestFile.path, mtimeMs: newestFile.mtimeMs }
        : null,
      oldestNote: oldestFile
        ? { path: oldestFile.path, mtimeMs: oldestFile.mtimeMs }
        : null,
    },
    tags: {
      unique: tags.totalUniqueTags,
      mostUsed: tags.tagCounts.slice(0, 10),
      untagged: tags.untaggedCount,
      coOccurrence: tags.coOccurrence.slice(0, 10),
    },
    links: {
      totalLinks: [...graph.forwardLinks.values()]
        .reduce((sum, s) => sum + s.size, 0),
      orphanCount: graph.orphans.length,
      brokenLinkCount: graph.brokenLinks.length,
      deadEndCount: deadEnds.length,
      mostLinked,
      orphans: graph.orphans,
      brokenLinks: graph.brokenLinks,
      deadEnds,
    },
  };
}
