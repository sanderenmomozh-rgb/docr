/**
 * Compute tag statistics from a Map<path, { body, frontmatter }>.
 */
export function computeTagStats(bodies) {
  const tagCounts = new Map();
  const coOccurrence = new Map();
  let totalTagApplications = 0;
  let untaggedCount = 0;

  const docs = [...bodies.entries()].map(([path, { frontmatter }]) => ({
    path,
    tags: frontmatter.tags || [],
  }));

  for (const doc of docs) {
    const tags = doc.tags;
    if (tags.length === 0) {
      untaggedCount++;
      continue;
    }
    totalTagApplications += tags.length;

    for (const tag of tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }

    // Co-occurrence: each pair of tags in the same document
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const key = [tags[i], tags[j]].sort().join("|||");
        if (!coOccurrence.has(key)) {
          coOccurrence.set(key, { tag1: tags[i], tag2: tags[j], count: 0 });
        }
        coOccurrence.get(key).count++;
      }
    }
  }

  const sortedTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));

  const sortedPairs = [...coOccurrence.values()]
    .sort((a, b) => b.count - a.count);

  return {
    tagCounts: sortedTags,
    totalUniqueTags: tagCounts.size,
    totalTagApplications,
    untaggedCount,
    totalDocs: docs.length,
    coOccurrence: sortedPairs,
  };
}

/**
 * Find potentially duplicate or highly similar documents using MiniSearch.
 * Returns pairs with similarity score above the threshold (0-1).
 */
export function findSimilarDocuments(index, threshold = 0.85) {
  const similar = [];
  const checked = new Set();

  // For each document, search using its own body as query
  const docs = index.toJSON ? index.documentCount : 0;

  for (let i = 0; i < index.documentCount; i++) {
    // MiniSearch doesn't expose documents directly, so we use
    // the stored search to find similar docs for each known path
  }

  // Alternative: use MiniSearch's auto-suggest and scoring
  // For now return empty — this needs the documents array
  return similar;
}
