import express from "express";

/**
 * Start a simple web UI for browsing and searching indexed docs.
 * Expects an already-built MiniSearch index.
 */
export function startServer(index, bodies, port = 3000) {
  const app = express();

  app.get("/", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head><title>Doc Organizer</title>
<style>
  body { font-family: system-ui; max-width: 700px; margin: 2rem auto; padding: 0 1rem; }
  input { width: 100%; padding: 0.75rem; font-size: 1.1rem; border: 2px solid #ccc; border-radius: 6px; }
  .result { margin: 1rem 0; padding: 0.75rem; border-left: 3px solid #4a90d9; background: #f9f9f9; }
  .result h3 { margin: 0 0 0.25rem; }
  .result .meta { font-size: 0.85rem; color: #666; }
  .result .snippet { margin-top: 0.3rem; }
</style></head>
<body>
  <h1>Doc Organizer</h1>
  <input type="text" id="q" placeholder="Search your notes..." autofocus />
  <div id="results"></div>
  <script>
    const inp = document.getElementById("q");
    const out = document.getElementById("results");
    inp.addEventListener("input", async () => {
      const q = inp.value.trim();
      if (!q) { out.innerHTML = ""; return; }
      const res = await fetch("/search?q=" + encodeURIComponent(q));
      const data = await res.json();
      out.innerHTML = data.map(r =>
        '<div class="result"><h3>' + esc(r.title) + '</h3>' +
        '<div class="meta">' + esc(r.filename) + (r.tags.length ? ' &middot; ' + r.tags.map(esc).join(', ') : '') + '</div>' +
        '<div class="snippet">' + esc(r.snippet) + '</div></div>'
      ).join("");
    });
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  </script>
</body></html>`);
  });

  app.get("/search", (req, res) => {
    try {
      const q = req.query.q || "";
      if (!q.trim()) return res.json([]);
      const raw = index.search(q.trim());
      const results = raw.slice(0, 20).map((r) => {
        const body = bodies.get(r.id) || "";
        const idx = body.toLowerCase().indexOf(q.toLowerCase());
        const start = Math.max(0, (idx >= 0 ? idx : 0) - 60);
        const snippet = body.slice(start, start + 200).replace(/\n/g, " ");
        return {
          title: r.title || r.id,
          filename: r.filename || "",
          tags: r.tags || [],
          snippet: snippet + (body.length > start + 200 ? "..." : ""),
        };
      });
      res.json(results);
    } catch (err) {
      console.error(`Search error: ${err.message}`);
      res.status(500).json({ error: "Search failed" });
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(`Server error: ${err.message}`);
    res.status(500).json({ error: "Internal server error" });
  });

  const server = app.listen(port, () => {
    console.log(`Web UI running at http://localhost:${port}`);
  });

  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });

  return server;
}
