/**
 * Find wiki pages related to a source document via content similarity.
 * Uses the existing MiniSearch index for full-text matching,
 * then layers tag overlap as a secondary score.
 */
export async function suggestLinks(analysis, index, bodies, opts = {}) {
  const maxResults = opts.maxResults || 10;

  // Build a query from the source content: summary + key terms
  const queryText = buildQueryText(analysis);
  if (!queryText) return [];

  // Search using MiniSearch
  let results = [];
  try {
    results = index.search(queryText, {
      fields: ["title", "body", "tags"],
      boost: { title: 3, tags: 2, body: 1 },
      prefix: true,
    });
  } catch {
    return [];
  }

  // Filter to wiki content pages only
  const isWikiPage = (path) => {
    if (!path) return false;
    if (path.includes("/templates/") || path.includes("\\templates\\")) return false;
    if (path.includes("/00_Inbox/") || path.includes("\\00_Inbox\\")) return false;
    if (path.includes("/01_Daily/") || path.includes("\\01_Daily\\")) return false;
    if (path.includes("/raw/") || path.includes("\\raw\\")) return false;
    return true;
  };

  // Get expected tags for the source type
  const expectedTags = getExpectedTags(analysis.type);
  const maxScore = results.length > 0 ? results[0].score : 1;

  return results
    .filter((r) => isWikiPage(r.id))
    .map((r) => {
      const entry = bodies.get(r.id);
      const tags = entry?.frontmatter?.tags || [];

      // Tag overlap score
      const overlap = expectedTags.filter((t) =>
        tags.some((tag) => tag.toLowerCase().includes(t.toLowerCase()))
      );
      const tagOverlap = expectedTags.length > 0
        ? overlap.length / expectedTags.length
        : 0;

      // Combined score: 70% MiniSearch + 30% tag overlap
      const normalizedSearch = maxScore > 0 ? r.score / maxScore : 0;
      const combined = 0.7 * normalizedSearch + 0.3 * tagOverlap;

      return {
        path: r.id,
        title: r.title || r.filename || r.id,
        score: Math.round(combined * 100) / 100,
        searchScore: Math.round(r.score * 100) / 100,
        tagOverlap: overlap,
        tags,
        snippet: makeSnippet(entry?.body || "", queryText),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

function buildQueryText(analysis) {
  const parts = [];
  if (analysis.summary) parts.push(analysis.summary);
  if (analysis.keyInfo?.scope) parts.push(analysis.keyInfo.scope);

  // For CSV: use csvHeaders as keywords
  if (analysis.format === "csv" && analysis.csvHeaders) {
    parts.push(analysis.csvHeaders.join(" "));
  }

  // For system spec: add topic keywords from filename
  if (analysis.type === "system-spec" || analysis.type === "policy-doc") {
    const base = analysis.filename.replace(/\.[^.]+$/, "");
    // Split filename on common separators
    const tokens = base.split(/[-_\s.]+/).filter((t) => t.length > 1);
    parts.push(tokens.join(" "));
  }

  const text = parts.join(" ").slice(0, 300);
  return text;
}

function getExpectedTags(type) {
  switch (type) {
    case "faq-csv":
      return ["answer", "faq"];
    case "system-spec":
    case "field-spec":
      return ["feature", "guide", "system", "entity"];
    case "policy-doc":
      return ["policy", "answer"];
    case "meeting-notes":
      return ["meeting"];
    default:
      return [];
  }
}

function makeSnippet(body, query) {
  if (!body) return "";
  const idx = body.toLowerCase().indexOf(query.slice(0, 20).toLowerCase());
  const start = Math.max(0, (idx >= 0 ? idx : 0) - 40);
  const snippet = body.slice(start, start + 150).replace(/\n/g, " ");
  return snippet + (body.length > start + 150 ? "..." : "");
}
