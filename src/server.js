import express from "express";
import { readFile, writeFile } from "node:fs/promises";
import matter from "gray-matter";
import { listInbox, confirmInbox, rejectInbox, previewInboxFile, detectType } from "./inbox.js";
import { analyzeSource } from "./analyze.js";
import { suggestLinks } from "./suggest.js";
import { previewImpact } from "./impact.js";
import { executeIngest } from "./ingest.js";
import { scanDirectory } from "./scanner.js";

/**
 * Start a simple web UI for browsing and searching indexed docs.
 * Expects an already-built MiniSearch index.
 */
export function startServer(index, bodies, port = 3000, files = []) {
  const app = express();
  app.use(express.json());

  function getVaultPath() {
    for (const f of files) {
      const p = f.path.replace(/\\/g, "/");
      const idx = p.indexOf("/wiki/");
      if (idx !== -1) return p.slice(0, idx);
      const idx2 = p.indexOf("/00_Inbox/");
      if (idx2 !== -1) return p.slice(0, idx2);
    }
    return "";
  }

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
  .btn-confirm { background: #d4edda; color: #155724; font-weight: 600; }
  .btn-reject { background: #f8d7da; color: #721c24; }
  .btn-ingest { background: #007acc; color: #fff; font-weight: 600; }
  .btn-ingest:disabled { opacity: 0.5; cursor: not-allowed; }
  .ingest-result { margin-top: 0.5rem; padding: 0.5rem; background: #e8f4e8; border-radius: 6px; font-size: 0.85rem; display: none; }
  button:hover { opacity: 0.8; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; justify-content: center; align-items: center; }
  .modal.active { display: flex; }
  .modal-content { background: #fff; border-radius: 8px; padding: 1.5rem; width: 90%; max-width: 700px; max-height: 80vh; overflow-y: auto; }
  .modal-content h3 { margin-bottom: 1rem; }
  .modal-content textarea { width: 100%; height: 300px; font-family: monospace; font-size: 0.85rem; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; resize: vertical; }
  .modal-content pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; font-size: 0.8rem; max-height: 50vh; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .modal-content .btns { margin-top: 1rem; display: flex; gap: 0.5rem; justify-content: flex-end; }
  .toast { position: fixed; bottom: 2rem; right: 2rem; background: #333; color: #fff; padding: 0.75rem 1.5rem; border-radius: 6px; z-index: 200; display: none; }
  .toast.show { display: block; }
  .empty { text-align: center; color: #999; padding: 3rem; }
  .nav { margin-bottom: 1rem; }
  .nav a { color: #4a90d9; text-decoration: none; }
  .tabs { display: flex; gap: 0; margin-bottom: 1.5rem; border-bottom: 2px solid #ddd; }
  .tab-btn { padding: 0.6rem 1.5rem; border: none; background: none; cursor: pointer; font-size: 0.95rem; color: #888; border-bottom: 2px solid transparent; margin-bottom: -2px; border-radius: 0; }
  .tab-btn.active { color: #4a90d9; border-bottom-color: #4a90d9; font-weight: 600; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .status-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
  .status-pending { background: #fff3cd; color: #856404; }
  .status-confirmed { background: #d4edda; color: #155724; }
  .status-rejected { background: #f8d7da; color: #721c24; }
  .inbox-summary { display: flex; gap: 1rem; margin-bottom: 1rem; }
  .inbox-summary span { background: #fff; border-radius: 6px; padding: 0.4rem 0.8rem; font-size: 0.85rem; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
</style></head>
<body>
  <div class="nav"><a href="/">← 搜索</a> | <a href="/dashboard">仪表盘</a></div>
  <h1>管理中心</h1>

  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('pending')">待发布审核</button>
    <button class="tab-btn" onclick="switchTab('inbox')">Inbox审核 <span id="inboxBadge"></span></button>
  </div>

  <!-- Tab 1: Pending Review -->
  <div class="tab-content active" id="tab-pending">
    <p class="sub" id="count">加载中...</p>
    <div id="list"></div>
  </div>

  <!-- Tab 2: Inbox Review -->
  <div class="tab-content" id="tab-inbox">
    <div id="inboxBanner" style="display:none;background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.9rem;"></div>
    <div class="inbox-summary" id="inboxSummary"></div>
    <div style="margin-bottom:0.75rem;"><button class="btn-view" onclick="loadInbox()">扫描新文件</button></div>
    <div id="inboxList"></div>
  </div>

  <div class="toast" id="toast"></div>

  <!-- Edit Modal (for pending pages) -->
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

  <!-- Preview Modal (for inbox items) -->
  <div class="modal" id="previewModal">
    <div class="modal-content">
      <h3 id="previewTitle">预览</h3>
      <pre id="previewBody"></pre>
      <div class="btns">
        <button class="btn-view" onclick="closePreview()">关闭</button>
      </div>
    </div>
  </div>

  <script>
    // ── Shared ──
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((b,i) => {
        b.classList.toggle('active', (tab==='pending'&&i===0) || (tab==='inbox'&&i===1));
      });
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + tab).classList.add('active');
      if (tab === 'inbox') loadInbox();
    }

    // ── Pending tab ──
    let currentEditPath = '';
    let pendingPages = [];

    async function loadPending() {
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
    function preview(i) { window.open('/doc/' + encodeURIComponent(pendingPages[i].path), '_blank'); }
    async function approve(i) {
      const p = pendingPages[i];
      if (!confirm('确认发布：' + p.title + '？')) return;
      const btn = event.target;
      btn.disabled = true; btn.textContent = '处理中...';
      const res = await fetch('/admin/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p.path })
      });
      if (res.ok) { showToast('已发布：' + p.title); loadPending(); }
      else { showToast('发布失败'); btn.disabled = false; btn.textContent = '审批通过'; }
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
    function closeEdit() { document.getElementById('editModal').classList.remove('active'); currentEditPath = ''; }
    async function saveEdit() {
      const newContent = document.getElementById('editContent').value;
      const res = await fetch('/admin/edit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentEditPath, content: newContent })
      });
      if (res.ok) {
        const res2 = await fetch('/admin/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: currentEditPath })
        });
        if (res2.ok) { closeEdit(); showToast('已编辑并发布'); loadPending(); }
      } else { showToast('保存失败'); }
    }

    // ── Inbox tab ──
    let inboxItems = [];

    async function loadInbox() {
      const res = await fetch('/admin/inbox');
      const data = await res.json();
      inboxItems = data.items;
      // Badge
      const badge = document.getElementById('inboxBadge');
      if (data.counts.pending > 0) {
        badge.textContent = data.counts.pending;
        badge.style.cssText = 'background:#e6a817;color:#fff;border-radius:10px;padding:0 6px;font-size:0.75rem;margin-left:4px;';
      } else { badge.textContent = ''; badge.style.cssText = ''; }
      // Banner
      const banner = document.getElementById('inboxBanner');
      if (data.counts.pending > 0) {
        banner.style.display = 'block';
        banner.innerHTML = '发现 <strong>' + data.counts.pending + '</strong> 个新文件待预审核，请预览后决定放行或拒绝。';
      } else { banner.style.display = 'none'; }
      // Summary
      document.getElementById('inboxSummary').innerHTML =
        '<span>总计: <strong>' + data.counts.total + '</strong></span>' +
        '<span style="color:#856404">待审核: <strong>' + data.counts.pending + '</strong></span>' +
        '<span style="color:#155724">已放行: <strong>' + data.counts.confirmed + '</strong></span>' +
        '<span style="color:#721c24">已拒绝: <strong>' + data.counts.rejected + '</strong></span>';
      // List
      const list = document.getElementById('inboxList');
      if (data.items.length === 0) {
        list.innerHTML = '<div class="empty">Inbox 为空</div>';
        return;
      }
      const statusLabel = { pending: '待审核', confirmed: '已放行', rejected: '已拒绝' };
      list.innerHTML = data.items.map((p, i) => {
        const badge = '<span class="status-badge status-' + p.status + '">' + (statusLabel[p.status]||p.status) + '</span>';
        const typeLabel = p.type || 'unknown';
        const sizeKB = (p.size / 1024).toFixed(1);
        const actions = p.status === 'pending'
          ? '<button class="btn-confirm" onclick="confirmInbox(' + i + ')">放行准入</button>' +
            '<button class="btn-reject" onclick="rejectInbox(' + i + ')">拒绝准入</button>'
          : (p.status === 'confirmed'
            ? '<button class="btn-ingest" onclick="ingestInbox(' + i + ')">执行摄入</button>' +
              '<span style="color:#155724;font-size:0.8rem;margin-left:0.5rem;">已放行 ' + (p.confirmedAt||'').slice(0,10) + '</span>'
            : '<span style="color:#721c24;font-size:0.8rem;">' + (p.reason ? '原因: '+esc(p.reason.slice(0,50)) : '已拒绝') + '</span>');
        const ingestResultDiv = p.status === 'confirmed'
          ? '<div class="ingest-result" id="ingestResult-' + i + '" style="display:none"></div>'
          : '';
        return '<div class="page">' +
          '<div class="info">' +
          '<div class="title">' + esc(p.filename) + ' ' + badge + '</div>' +
          '<div class="meta">' + typeLabel + ' · ' + sizeKB + ' KB · ' + new Date(p.mtimeMs).toLocaleDateString('zh-CN') + '</div>' +
          '</div>' +
          '<div class="actions">' +
          '<button class="btn-view" onclick="previewInbox(' + i + ')">预览</button>' +
          actions +
          '</div>' +
          ingestResultDiv +
          '</div>';
      }).join('');
    }

    async function confirmInbox(i) {
      const p = inboxItems[i];
      if (!confirm('放行准入：' + p.filename + '？')) return;
      const res = await fetch('/admin/inbox/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: p.filename, type: p.type })
      });
      if (res.ok) { showToast('已放行：' + p.filename); loadInbox(); }
      else { showToast('放行失败'); }
    }

    async function rejectInbox(i) {
      const p = inboxItems[i];
      const reason = prompt('拒绝原因（可选）：');
      if (reason === null) return;
      const res = await fetch('/admin/inbox/reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: p.filename, reason: reason || '' })
      });
      if (res.ok) { showToast('已拒绝：' + p.filename); loadInbox(); }
      else { showToast('拒绝失败'); }
    }

    async function ingestInbox(i) {
      const p = inboxItems[i];
      if (!confirm('执行摄入：' + p.filename + '\\n\\n这将创建 wiki 页面并归档源文件。确定继续？')) return;

      // Disable all ingest buttons while running
      const btns = document.querySelectorAll('.btn-ingest');
      btns.forEach(b => b.disabled = true);

      const resultDiv = document.getElementById('ingestResult-' + i);
      if (resultDiv) {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = '⏳ 正在摄入...';
      }

      try {
        const res = await fetch('/admin/inbox/ingest/' + encodeURIComponent(p.filename), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: false })
        });
        const data = await res.json();

        if (res.ok && data.ok) {
          const lines = [];
          lines.push('✅ 摄入完成！');
          if (data.created && data.created.length > 0) {
            lines.push('创建 ' + data.created.length + ' 个页面：');
            data.created.forEach(c => lines.push('  · ' + c.title));
          }
          if (data.archivedPath) {
            lines.push('归档：' + data.archivedPath);
          }
          if (resultDiv) resultDiv.innerHTML = lines.join('<br>');
          showToast('摄入完成：' + p.filename);
          setTimeout(() => loadInbox(), 1500);
        } else {
          const msg = data.skipped
            ? '⚠ 跳过：' + (data.reason || '未知原因')
            : '❌ 失败：' + (data.error || '未知错误');
          if (resultDiv) resultDiv.innerHTML = msg;
          showToast(msg);
        }
      } catch (err) {
        if (resultDiv) resultDiv.innerHTML = '❌ 网络错误：' + err.message;
        showToast('摄入请求失败');
      } finally {
        btns.forEach(b => b.disabled = false);
      }
    }

    async function previewInbox(i) {
      const p = inboxItems[i];
      document.getElementById('previewTitle').textContent = '预览：' + p.filename;
      document.getElementById('previewBody').innerHTML = '<div style="text-align:center;color:#999;padding:2rem;">加载中...</div>';
      document.getElementById('previewModal').classList.add('active');
      // Fetch structured summary
      let summary;
      try {
        const res = await fetch('/admin/inbox/summary/' + encodeURIComponent(p.filename));
        summary = await res.json();
      } catch { summary = null; }
      // Fetch raw text for fallback
      let raw;
      try {
        const res2 = await fetch('/admin/inbox/preview/' + encodeURIComponent(p.filename));
        raw = await res2.json();
      } catch { raw = null; }

      const body = document.getElementById('previewBody');
      if (!summary || summary.error) {
        body.innerHTML = '<div style="color:#721c24;">无法生成摘要: ' + (summary?.error || raw?.error || 'unknown') + '</div>';
        return;
      }

      const ki = summary.keyInfo || {};
      const sp = summary.suggestedPlacement || {};
      const sizeStr = summary.size ? (summary.size / 1024).toFixed(1) + ' KB' : '?';
      const flagHtml = ki.hasTemporalFlag ? '<div style="color:#e6a817;margin-top:0.3rem;">⚠ 包含时效性数据</div>' : '';

      let rawHtml = '';
      if (raw && !raw.error && raw.preview) {
        rawHtml = '<details style="margin-top:0.75rem;"><summary style="cursor:pointer;color:#4a90d9;font-size:0.85rem;">查看原文</summary><pre style="background:#f5f5f5;padding:0.75rem;border-radius:4px;overflow-x:auto;font-size:0.75rem;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin-top:0.5rem;">' + esc(raw.preview.slice(0, 3000)) + '</pre></details>';
      }

      body.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:0.75rem;">' +
        '<div><span style="color:#888;font-size:0.8rem;">类型</span><br>' + esc(summary.type) + '</div>' +
        '<div><span style="color:#888;font-size:0.8rem;">格式</span><br>' + esc(summary.format) + '</div>' +
        '<div><span style="color:#888;font-size:0.8rem;">字数</span><br>' + (summary.wordCount||0) + '</div>' +
        '<div><span style="color:#888;font-size:0.8rem;">大小</span><br>' + sizeStr + '</div>' +
        '</div>' +
        (summary.summary ? '<div style="margin-bottom:0.75rem;"><span style="color:#888;font-size:0.8rem;">摘要</span><br>' + esc(summary.summary) + '</div>' : '') +
        (ki.scope ? '<div style="margin-bottom:0.75rem;"><span style="color:#888;font-size:0.8rem;">适用对象</span><br>' + esc(ki.scope) + '</div>' : '') +
        flagHtml +
        (sp.wikiDir ? '<div style="margin-top:0.75rem;"><span style="color:#888;font-size:0.8rem;">建议放置</span><br>目录: ' + esc(sp.wikiDir) + '<br>文件名: ' + esc(sp.suggestedFilename||'') + '.md<br>模板: ' + esc(sp.template||'') + '</div>' : '') +
        rawHtml;
    }

    function closePreview() { document.getElementById('previewModal').classList.remove('active'); }

    loadPending();
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
      const vaultPath = getVaultPath();
      // Fresh scan — picks up pages created after server start
      const currentFiles = await scanDirectory(vaultPath, {
        ignorePatterns: [".obsidian", ".trash", ".docr-cache"],
      });

      const pending = [];
      for (const f of currentFiles) {
        const isTemplate = f.path.includes("/templates/") || f.path.includes("\\templates\\");
        if (isTemplate) continue;
        try {
          const raw = await readFile(f.path, "utf-8");
          const parsed = matter(raw);
          const fm = parsed.data || {};
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
        } catch {
          // skip unreadable files
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

      // Update in-memory bodies map
      const entry = bodies.get(docPath);
      if (entry) {
        entry.frontmatter = parsed.data;
        entry.body = parsed.content;
      }

      // Append to _log.md
      const vaultDir = files[0]?.path?.replace(/\/wiki\/.*/, "") || "";
      const logPath = vaultDir + "/wiki/_log.md";
      try {
        const logRaw = await readFile(logPath, "utf-8");
        const pageName = docPath.replace(/\\/g, "/").split("/").pop().replace(".md", "");
        const logEntry = `\n## [${today}] review | [[${pageName}]] → published\n\n审核人：${reviewer || "Sande"}\n`;
        await writeFile(logPath, logRaw + logEntry, "utf-8");
      } catch (e) {
        console.error(`Log update failed: ${e.message}`);
      }

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

  // ── Inbox API ──

  app.get("/admin/inbox", async (_req, res) => {
    try {
      const vaultPath = getVaultPath();
      const items = await listInbox(vaultPath, "all");
      for (const item of items) {
        if (!item.type) item.type = detectType(item);
      }
      const counts = {
        total: items.length,
        pending: items.filter((i) => i.status === "pending").length,
        confirmed: items.filter((i) => i.status === "confirmed").length,
        rejected: items.filter((i) => i.status === "rejected").length,
      };
      res.json({ items, counts });
    } catch (err) {
      console.error(`Inbox list error: ${err.message}`);
      res.status(500).json({ error: "Failed" });
    }
  });

  app.get("/admin/inbox/preview/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filePath = join(vaultPath, "00_Inbox", decodeURIComponent(req.params.filename));
      const result = await previewInboxFile(filePath);
      res.json(result);
    } catch (err) {
      console.error(`Inbox preview error: ${err.message}`);
      res.status(500).json({ error: "Preview failed" });
    }
  });

  app.get("/admin/inbox/summary/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filePath = join(vaultPath, "00_Inbox", decodeURIComponent(req.params.filename));
      const result = await analyzeSource(filePath, vaultPath);
      res.json(result);
    } catch (err) {
      console.error(`Inbox summary error: ${err.message}`);
      res.status(500).json({ error: "Summary failed" });
    }
  });

  app.post("/admin/inbox/confirm", async (req, res) => {
    try {
      const { filename, type, notes } = req.body || {};
      if (!filename) return res.status(400).json({ error: "filename required" });
      const vaultPath = getVaultPath();
      await confirmInbox(vaultPath, filename, { type, notes });
      res.json({ ok: true, filename, status: "confirmed" });
    } catch (err) {
      console.error(`Inbox confirm error: ${err.message}`);
      res.status(500).json({ error: "Confirm failed" });
    }
  });

  app.post("/admin/inbox/reject", async (req, res) => {
    try {
      const { filename, reason } = req.body || {};
      if (!filename) return res.status(400).json({ error: "filename required" });
      const vaultPath = getVaultPath();
      await rejectInbox(vaultPath, filename, reason || "");
      res.json({ ok: true, filename, status: "rejected" });
    } catch (err) {
      console.error(`Inbox reject error: ${err.message}`);
      res.status(500).json({ error: "Reject failed" });
    }
  });

  app.post("/admin/inbox/analyze/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filename = decodeURIComponent(req.params.filename);
      const filePath = join(vaultPath, "00_Inbox", filename);
      // Check confirmed
      const items = await listInbox(vaultPath, "confirmed");
      if (!items.find((i) => i.filename === filename)) {
        return res.status(400).json({ error: "Source not confirmed" });
      }
      const result = await analyzeSource(filePath, vaultPath);
      res.json(result);
    } catch (err) {
      console.error(`Inbox analyze error: ${err.message}`);
      res.status(500).json({ error: "Analyze failed" });
    }
  });

  app.post("/admin/inbox/suggest/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filename = decodeURIComponent(req.params.filename);
      const filePath = join(vaultPath, "00_Inbox", filename);
      const items = await listInbox(vaultPath, "confirmed");
      if (!items.find((i) => i.filename === filename)) {
        return res.status(400).json({ error: "Source not confirmed" });
      }
      const analysis = await analyzeSource(filePath, vaultPath);
      const result = await suggestLinks(analysis, index, bodies, { maxResults: 10 });
      res.json(result);
    } catch (err) {
      console.error(`Inbox suggest error: ${err.message}`);
      res.status(500).json({ error: "Suggest failed" });
    }
  });

  app.post("/admin/inbox/impact/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filename = decodeURIComponent(req.params.filename);
      const filePath = join(vaultPath, "00_Inbox", filename);
      const items = await listInbox(vaultPath, "confirmed");
      if (!items.find((i) => i.filename === filename)) {
        return res.status(400).json({ error: "Source not confirmed" });
      }
      const analysis = await analyzeSource(filePath, vaultPath);
      const suggestions = await suggestLinks(analysis, index, bodies);
      const result = await previewImpact(analysis, suggestions, vaultPath);
      res.json(result);
    } catch (err) {
      console.error(`Inbox impact error: ${err.message}`);
      res.status(500).json({ error: "Impact failed" });
    }
  });

  app.post("/admin/inbox/ingest/:filename", async (req, res) => {
    try {
      const vaultPath = getVaultPath();
      const { join } = await import("node:path");
      const filename = decodeURIComponent(req.params.filename);
      const filePath = join(vaultPath, "00_Inbox", filename);

      // Check confirmed
      const items = await listInbox(vaultPath, "confirmed");
      if (!items.find((i) => i.filename === filename)) {
        return res.status(400).json({ error: "Source not confirmed. Use '放行准入' first." });
      }

      const { force } = req.body || {};
      const result = await executeIngest(filePath, vaultPath, index, bodies, {
        dryRun: false,
        force: force || false,
      });

      res.json({
        ok: !result.skipped,
        ...result,
      });
    } catch (err) {
      console.error(`Inbox ingest error: ${err.message}`);
      res.status(500).json({ error: "Ingest failed: " + err.message });
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
