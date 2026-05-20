/**
 * Query the index and return ranked results with snippets.
 * The bodies map (path -> body text) is used to extract context snippets.
 */
export function search(index, bodies, query) {
  const raw = index.search(query);

  return raw.slice(0, 20).map((r) => ({
    ...r,
    snippet: makeSnippet(bodies.get(r.id) || "", query),
  }));
}

function makeSnippet(body, query) {
  if (!body) return "";

  const idx = body.toLowerCase().indexOf(query.toLowerCase());

  if (idx === -1) return body.slice(0, 150) + (body.length > 150 ? "..." : "");

  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + query.length + 90);
  let snippet = body.slice(start, end).replace(/\n/g, " ");
  if (start > 0) snippet = "..." + snippet;
  if (end < body.length) snippet = snippet + "...";

  return snippet;
}
