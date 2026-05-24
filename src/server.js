import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";

/**
 * Start a simple web UI for browsing and searching indexed docs.
 * Expects an already-built MiniSearch index.
 */
export function startServer(index, bodies, port = 3000, files = []) {
  const app = express();
  app.use(express.json());

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
  <div style="margin-bottom:1rem;"><a href="/dashboard" style="color:#4a90d9;text-decoration:none;">仪表盘</a> | <a href="/admin" style="color:#4a90d9;text-decoration:none;">审核</a></div>
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

  app.get("/admin", (_req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head><title>审核发布</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; padding: 2rem; }
  h1 { margin-bottom: 0.5rem; }
  .sub { color: #999; font-size: 0.9rem; margin-bottom: 1.5rem; }
  .page { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.08); display: flex; align-items: center; gap: 1rem; }
  .page .info { flex: 1; min-width: 0; }
  .page .title { font-weight: 600; }
  .page .meta { font-size: 0.8rem; color: #888; margin-top: 0.2rem; }
  .page .actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
  button { padding: 0.4rem 0.9rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .btn-view { background: #e8f0fe; color: #4a90d9; }
  .btn-edit { background: #fff3cd; color: #856404; }
  .btn-approve { background: #d4edda; color: #155724; font-weight: 600; }
  button:hover { opacity: 0.8; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; }
  .modal.active { display: flex; }
  .modal-content { background: #fff; border-radius: 8px; padding: 1.5rem; width: 90%; max-width: 700px; max-height: 80vh; overflow-y: auto; }
  .modal-content h3 { margin-bottom: 1rem; }
  .modal-content textarea { width: 100%; height: 300px; font-family: monospace; font-size: 0.85rem; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; resize: vertical; }
  .modal-content .btns { margin-top: 1rem; display: flex; gap: 0.5rem; justify-content: flex-end; }
  .toast { position: fixed; bottom: 2rem; right: 2rem; background: #333; color: #fff; padding: 0.75rem 1.5rem; border-radius: 6px; z-index: 200; display: none; }
  .toast.show { display: block; }
  .empty { text-align: center; color: #999; padding: 3rem; }
  .nav { margin-bottom: 1rem; }
  .nav a { color: #4a90d9; text-decoration: none; }
</style></head>
<body>
  <div class="nav"><a href="/">← 搜索</a> | <a href="/dashboard">仪表盘</a></div>
  <h1>审核发布</h1>
  <p class="sub" id="count">加载中...</p>
  <div id="list"></div>
  <div class="toast" id="toast"></div>

  <div class="modal" id="editModal">
    <div class="modal-content">
      <h3 id="editTitle">编辑</h3>
      <textarea id="editContent"></textarea>
      <div class="btns">
        <button class="btn-view" onclick="closeEdit()">取消</button>
        <button class="btn-approve" onclick="saveEdit()">保存并发布</button>
      </div>
    </div>
  </div>

  <script>
    let currentEditPath = '';
    let pendingPages = [];

    async function load() {
      const res = await fetch('/admin/pending');
      const data = await res.json();
      pendingPages = data.pages;
      document.getElementById('count').textContent = '待审核：' + data.total + ' 页';
      const list = document.getElementById('list');
      if (data.total === 0) {
        list.innerHTML = '<div class="empty">所有页面已发布</div>';
        return;
      }
      list.innerHTML = data.pages.map((p, i) =>
        '<div class="page">' +
        '<div class="info">' +
        '<div class="title">' + esc(p.title) + '</div>' +
        '<div class="meta">' + esc(p.filename) + (p.scope ? ' · ' + esc(p.scope) : '') + (p.reviewer ? ' · 审核人: ' + esc(p.reviewer) : '') + '</div>' +
        '</div>' +
        '<div class="actions">' +
        '<button class="btn-view" onclick="preview(' + i + ')">预览</button>' +
        '<button class="btn-edit" onclick="startEdit(' + i + ')">编辑</button>' +
        '<button class="btn-approve" onclick="approve(' + i + ')">审批通过</button>' +
        '</div></div>'
      ).join('');
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    function preview(i) {
      window.open('/doc/' + encodeURIComponent(pendingPages[i].path), '_blank');
    }

    async function approve(i) {
      const p = pendingPages[i];
      if (!confirm('确认发布：' + p.title + '？')) return;
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = '处理中...';
      const res = await fetch('/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p.path })
      });
      if (res.ok) {
        showToast('已发布：' + p.title);
        load();
      } else {
        showToast('发布失败');
        btn.disabled = false;
        btn.textContent = '审批通过';
      }
    }

    async function startEdit(i) {
      const p = pendingPages[i];
      currentEditPath = p.path;
      document.getElementById('editTitle').textContent = '编辑：' + p.title;
      const res = await fetch('/admin/full?path=' + encodeURIComponent(p.path));
      const data = await res.json();
      document.getElementById('editContent').value = data.content;
      document.getElementById('editModal').classList.add('active');
    }

    function closeEdit() {
      document.getElementById('editModal').classList.remove('active');
      currentEditPath = '';
    }

    async function saveEdit() {
      const newContent = document.getElementById('editContent').value;
      // Save content
      const res = await fetch('/admin/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentEditPath, content: newContent })
      });

      if (res.ok) {
        // Then approve
        const res2 = await fetch('/admin/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentEditPath })
        });
        if (res2.ok) {
          closeEdit();
          showToast('已编辑并发布');
          load();
        }
      } else {
        showToast('保存失败');
      }
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    load();
  </script>
</body></html>`);
  });

  // Full raw file content for edit
  app.get("/admin/full", async (req, res) => {
    try {
      const docPath = req.query.path;
      if (!docPath) return res.status(400).json({ error: "path required" });
      const raw = await readFile(docPath, "utf-8");
      res.json({ content: raw });
    } catch (err) {
      res.status(500).json({ error: "Read failed" });
    }
  });

  // ── Admin API ──

  app.get("/admin/pending", async (_req, res) => {
    try {
      const pending = [];
      for (const f of files) {
        const entry = bodies.get(f.path);
        if (!entry) continue;
        const isTemplate = f.path.includes("/templates/") || f.path.includes("\\templates\\");
        if (isTemplate) continue;
        const fm = entry.frontmatter || {};
        if (fm.status === "draft-pending-review") {
          pending.push({
            path: f.path,
            filename: f.path.split("/").pop(),
            title: fm.title || f.path.split("/").pop().replace(".md", ""),
            tags: fm.tags || [],
            scope: fm.scope || "",
            date: fm.date || "",
            reviewer: fm.reviewer || "",
          });
        }
      }
      res.json({ total: pending.length, pages: pending });
    } catch (err) {
      console.error(`Admin pending error: ${err.message}`);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.post("/admin/approve", async (req, res) => {
    try {
      const { path: docPath, reviewer } = req.body || {};
      if (!docPath) return res.status(400).json({ error: "path required" });

      const raw = await readFile(docPath, "utf-8");
      const parsed = matter(raw);

      const today = new Date().toISOString().slice(0, 10);
      parsed.data.status = "published";
      parsed.data.reviewer = reviewer || "Sande";
      parsed.data.review_date = today;

      const newContent = matter.stringify(parsed.content, parsed.data);
      await writeFile(docPath, newContent, "utf-8");

      // Append to _log.md
      const vaultDir = process.env.VAULT_DIR || files[0]?.path?.split("/wiki/")[0] || "";
      const logPath = vaultDir + "/wiki/_log.md";
      try {
        const logRaw = await readFile(logPath, "utf-8");
        const pageName = docPath.split("/").pop().replace(".md", "");
        const logEntry = `\n## [${today}] review | [[${pageName}]] 审核通过 → published\n\n审核人：${reviewer || "Sande"}\n`;
        await writeFile(logPath, logRaw + logEntry, "utf-8");
      } catch (e) {
        console.error(`Log update failed: ${e.message}`);
      }

      // Rebuild index
      const { buildIndex } = await import("./indexer.js");
      const { index: newIdx, bodies: newBodies } = await buildIndex(files);
      Object.assign(bodies, Object.fromEntries(newBodies));
      index.tokenSet = newIdx.tokenSet;
      index._documentIds = newIdx._documentIds;
      index.documentCount = newIdx.documentCount;
      Object.assign(index._fieldIds, newIdx._fieldIds);
      Object.assign(index._storedFields, newIdx._storedFields);
      Object.assign(index._index, newIdx._index);

      res.json({ ok: true, page: docPath, status: "published" });
    } catch (err) {
      console.error(`Admin approve error: ${err.message}`);
      res.status(500).json({ error: "Approve failed" });
    }
  });

  app.post("/admin/edit", async (req, res) => {
    try {
      const { path: docPath, content } = req.body || {};
      if (!docPath || content === undefined) return res.status(400).json({ error: "path and content required" });

      await writeFile(docPath, content, "utf-8");

      // Rebuild index
      const { buildIndex } = await import("./indexer.js");
      const { index: newIdx, bodies: newBodies } = await buildIndex(files);
      Object.assign(bodies, Object.fromEntries(newBodies));
      index.tokenSet = newIdx.tokenSet;
      index._documentIds = newIdx._documentIds;
      index.documentCount = newIdx.documentCount;
      Object.assign(index._fieldIds, newIdx._fieldIds);
      Object.assign(index._storedFields, newIdx._storedFields);
      Object.assign(index._index, newIdx._index);

      res.json({ ok: true, page: docPath });
    } catch (err) {
      console.error(`Admin edit error: ${err.message}`);
      res.status(500).json({ error: "Edit failed" });
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
