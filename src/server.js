import express from "express";

/**
 * Start a simple web UI for browsing and searching indexed docs.
 * Expects an already-built MiniSearch index.
 */
export function startServer(index, bodies, port = 3000, files = []) {
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
  .result h3 a { color: #4a90d9; text-decoration: none; }
  .result h3 a:hover { text-decoration: underline; }
  .result .meta { font-size: 0.85rem; color: #666; }
  .result .snippet { margin-top: 0.3rem; }
</style></head>
<body>
  <div style="margin-bottom:1rem;"><a href="/dashboard" style="color:#4a90d9;text-decoration:none;">仪表盘</a></div>
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
        '<div class="result"><h3><a href="/doc/' + encodeURIComponent(r.path) + '">' + esc(r.title) + '</a></h3>' +
        '<div class="meta">' + esc(r.filename) + (r.tags.length ? ' &middot; ' + r.tags.map(esc).join(', ') : '') + '</div>' +
        '<div class="snippet">' + esc(r.snippet) + '</div></div>'
      ).join("");
    });
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  </script>
</body></html>`);
  });

  app.get("/doc/*", (req, res) => {
    try {
      const path = decodeURIComponent(req.params[0]);
      const body = bodies.get(path);
      if (!body) return res.status(404).send("<h1>Not found</h1>");
      const H = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const title = H(body.frontmatter?.title || path.split("/").pop().replace(".md", ""));
      const content = H(body.body);
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6;}pre{background:#f5f5f5;padding:1rem;border-radius:6px;overflow-x:auto;}a{color:#4a90d9;}.back{margin-bottom:1.5rem;}</style></head><body><div class="back"><a href="/">← 搜索</a></div><div style="white-space:pre-wrap;font-family:inherit;">' + content + '</div></body></html>';
      res.send(html);
    } catch (err) {
      res.status(500).json({ error: "Doc failed" });
    }
  });

  app.get("/search", (req, res) => {
    try {
      const q = req.query.q || "";
      if (!q.trim()) return res.json([]);
      const raw = index.search(q.trim());
      const results = raw.slice(0, 20).map((r) => {
        const body = bodies.get(r.id)?.body || "";
        const idx = body.toLowerCase().indexOf(q.toLowerCase());
        const start = Math.max(0, (idx >= 0 ? idx : 0) - 60);
        const snippet = body.slice(start, start + 200).replace(/\n/g, " ");
        return {
          title: r.title || r.id,
          filename: r.filename || "",
          path: r.id || "",
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

  app.get("/stats", async (_req, res) => {
    try {
      const { computeDashboard } = await import("./dashboard.js");
      const dash = await computeDashboard(index, bodies, files);
      res.json(dash);
    } catch (err) {
      console.error(`Stats error: ${err.message}`);
      res.status(500).json({ error: "Stats failed" });
    }
  });

  app.get("/dashboard", async (_req, res) => {
    try {
      const { computeDashboard } = await import("./dashboard.js");
      const dash = await computeDashboard(index, bodies, files);
      const v = dash.vault;
      const t = dash.tags;
      const l = dash.links;
      const H = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

      const barWidth = (count) => Math.round((count / t.mostUsed[0].count) * 100);

      const tagBars = t.mostUsed.map(tag =>
        `<div class="tag-row"><span class="tag-name">${H(tag.tag)}</span><span class="tag-bar"><span class="tag-fill" style="width:${barWidth(tag.count)}%"></span></span><span class="tag-count">${tag.count}</span></div>`
      ).join("");

      const orphanList = l.orphans.length
        ? l.orphans.slice(0, 20).map(p => `<li>${H(p)}</li>`).join("")
        : "<li>无孤页</li>";

      const brokenList = l.brokenLinks.length
        ? l.brokenLinks.slice(0, 20).map(b => `<li>${H(b.from)} → [[${H(b.to)}]]</li>`).join("")
        : "<li>无断链</li>";

      const linkedList = l.mostLinked.map(p =>
        `<li><strong>${p.incomingCount}</strong> ← ${H(p.path)}</li>`
      ).join("");

      res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><title>知识库仪表盘</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; padding: 2rem; }
  h1 { margin-bottom: 1.5rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .card { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card .label { font-size: 0.8rem; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .value { font-size: 2rem; font-weight: 700; color: #4a90d9; }
  section { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  section h2 { font-size: 1.1rem; margin-bottom: 1rem; color: #555; border-bottom: 2px solid #4a90d9; padding-bottom: 0.5rem; }
  .tag-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.4rem; }
  .tag-name { width: 120px; text-align: right; font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag-bar { flex: 1; height: 20px; background: #eee; border-radius: 10px; overflow: hidden; }
  .tag-fill { display: block; height: 100%; background: linear-gradient(90deg, #4a90d9, #357abd); border-radius: 10px; transition: width 0.5s; }
  .tag-count { width: 40px; font-size: 0.8rem; color: #888; }
  ul { list-style: none; }
  li { font-size: 0.85rem; padding: 0.25rem 0; border-bottom: 1px solid #f0f0f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li:last-child { border-bottom: none; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 768px) { .cols { grid-template-columns: 1fr; } }
  .warning { color: #e6a817; }
  .danger { color: #d94a4a; }
  .nav { margin-bottom: 1rem; }
  .nav a { color: #4a90d9; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
</style></head>
<body>
  <div class="nav"><a href="/">← 搜索</a></div>
  <h1>知识库仪表盘</h1>

  <div class="cards">
    <div class="card"><div class="label">文档数</div><div class="value">${v.totalNotes}</div></div>
    <div class="card"><div class="label">总词数</div><div class="value">${(v.totalWords/1000).toFixed(1)}K</div></div>
    <div class="card"><div class="label">篇均词数</div><div class="value">${v.avgWordsPerNote}</div></div>
    <div class="card"><div class="label">总大小</div><div class="value">${v.totalSizeKb} KB</div></div>
  </div>

  <section>
    <h2>标签分布 (${t.unique} 个唯一标签)</h2>
    ${tagBars}
    <p style="margin-top:0.75rem;font-size:0.8rem;color:#999;">未标签订阅: ${t.untagged} 篇</p>
  </section>

  <div class="cols">
    <section>
      <h2>最高入链页面</h2>
      <ul>${linkedList}</ul>
    </section>
    <section>
      <h2>链接健康度</h2>
      <div class="cards" style="grid-template-columns:1fr 1fr;">
        <div class="card"><div class="label">总链接</div><div class="value">${l.totalLinks}</div></div>
        <div class="card"><div class="label">断链</div><div class="value danger">${l.brokenLinkCount}</div></div>
        <div class="card"><div class="label">孤页</div><div class="value warning">${l.orphanCount}</div></div>
        <div class="card"><div class="label">死胡同</div><div class="value warning">${l.deadEndCount}</div></div>
      </div>
    </section>
  </div>

  <div class="cols">
    <section>
      <h2>断链详情 (${l.brokenLinkCount})</h2>
      <ul>${brokenList}</ul>
      ${l.brokenLinks.length > 20 ? '<p style="font-size:0.8rem;color:#999;">... 仅显示前 20 条</p>' : ''}
    </section>
    <section>
      <h2>孤页 (${l.orphanCount})</h2>
      <ul>${orphanList}</ul>
      ${l.orphans.length > 20 ? '<p style="font-size:0.8rem;color:#999;">... 仅显示前 20 条</p>' : ''}
    </section>
  </div>
</body></html>`);
    } catch (err) {
      console.error(`Dashboard error: ${err.message}`);
      res.status(500).json({ error: "Dashboard failed" });
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
