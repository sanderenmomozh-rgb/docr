/**
 * Extract all [[wikilinks]] and ![[embeds]] from markdown body text.
 * Returns an array of { target, display, heading, isEmbed } objects.
 */
export function extractWikilinks(body) {
  if (!body) return [];
  const results = [];
  const re = /!?\[\[([^\]|#]+)(?:#([^\]|]*))?(?:\|([^\]]+))?\]\]/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    results.push({
      target: match[1].trim(),
      heading: match[2]?.trim() || null,
      display: match[3]?.trim() || null,
      isEmbed: match[0].startsWith("!"),
    });
  }
  return results;
}

/**
 * Build a link graph from indexed documents.
 * Each doc should have { path, title, aliases, body }.
 *
 * Returns:
 *   forwardLinks: Map<sourcePath, Set<targetTitle>>
 *   backlinks: Map<targetTitle, Set<sourcePath>>
 *   orphans: paths with zero incoming links
 *   brokenLinks: [{ source, target }] where target matches no document title/alias
 */
export function buildLinkGraph(documents) {
  const forwardLinks = new Map();
  const backlinks = new Map();
  const brokenLinks = [];

  // Build a lookup: title → path(s), for resolving targets
  const titleToPaths = new Map();
  const aliasToPaths = new Map();
  for (const doc of documents) {
    const key = doc.title.toLowerCase();
    if (!titleToPaths.has(key)) titleToPaths.set(key, []);
    titleToPaths.get(key).push(doc.path);
    for (const alias of doc.aliases || []) {
      const akey = alias.toLowerCase();
      if (!aliasToPaths.has(akey)) aliasToPaths.set(akey, []);
      aliasToPaths.get(akey).push(doc.path);
    }
  }

  // Extract links from each document
  const allPaths = new Set(documents.map((d) => d.path));

  for (const doc of documents) {
    const links = extractWikilinks(doc.body || "");
    const targets = new Set();
    for (const link of links) {
      const target = link.target;
      targets.add(target);

      // Resolve target to actual paths
      const tkey = target.toLowerCase();
      const targetPaths =
        titleToPaths.get(tkey) || aliasToPaths.get(tkey);

      if (!targetPaths || targetPaths.length === 0) {
        brokenLinks.push({ source: doc.path, target });
      }

      // Build backlinks: for each resolved target path, add this doc as a backlink
      if (targetPaths) {
        for (const tPath of targetPaths) {
          if (!backlinks.has(tPath)) backlinks.set(tPath, new Set());
          backlinks.get(tPath).add(doc.path);
        }
      }
    }
    forwardLinks.set(doc.path, targets);
  }

  // Find orphans: docs with no incoming backlinks
  const orphans = [];
  for (const doc of documents) {
    const incoming = backlinks.get(doc.path);
    if (!incoming || incoming.size === 0) {
      orphans.push(doc.path);
    }
  }

  return { forwardLinks, backlinks, orphans, brokenLinks };
}

/**
 * Extract inline #tags from body text (in addition to frontmatter tags).
 */
export function extractInlineTags(body) {
  if (!body) return [];
  const re = /(?<!\w)#([a-zA-Z一-鿿][\w一-鿿/-]*)/g;
  const tags = new Set();
  let match;
  while ((match = re.exec(body)) !== null) {
    tags.add(match[1]);
  }
  return [...tags];
}
