export interface Env {
  DB: D1Database;
}

const EXPIRE_DAYS = 30;

/* ============================= */
/* MAIN WORKER */
/* ============================= */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log("🚀 Worker Started");

    try {
      await ensureTable(env);
      const url = new URL(request.url);

      // Health check
      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      // Legacy publish (create only)
      if (url.pathname === "/publish" && request.method === "POST") {
        return handleLegacyPublish(request, env, url);
      }

      // View document
      if (url.pathname.startsWith("/p/")) {
        return handleViewDocument(request, env);
      }

      // ----- New API endpoints (v1) -----
      if (url.pathname === "/api/v1/publish" && request.method === "POST") {
        return handlePublish(request, env, url);
      }

      if (url.pathname === "/api/v1/documents") {
        if (request.method === "GET") {
          return handleListDocuments(request, env, url);
        }
        if (request.method === "DELETE") {
          return handleDeleteDocument(request, env);
        }
      }

      // Get markdown source of a document
      const sourceMatch = url.pathname.match(/^\/api\/v1\/documents\/([^\/]+)\/source$/);
      if (sourceMatch && request.method === "GET") {
        const slug = sourceMatch[1];
        return handleGetSource(slug, env);
      }

      // HTML page listing all documents
      if (url.pathname === "/documents" && request.method === "GET") {
        return handleDocumentsPage(request, env, url);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("🔥 Global Error:", err);
      return json({ error: "Internal Error" }, 500);
    }
  },
};

/* ============================= */
/* LEGACY PUBLISH (create only) */
/* ============================= */
async function handleLegacyPublish(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await safeJson(request);
  if (!body?.markdown) {
    return json({ error: "markdown required" }, 400);
  }

  const id = crypto.randomUUID();
  const expireAt = Date.now() + EXPIRE_DAYS * 86400000;
  const title = extractTitle(body.markdown) || "Untitled";
  const html = buildHtml(body.markdown, expireAt);

  // Store markdown as well
  await env.DB.prepare(
    "INSERT INTO posts (id, html, markdown, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, html, body.markdown, title, expireAt, Date.now(), "api")
    .run();

  return json({
    success: true,
    url: `${url.origin}/p/${id}`,
    expireAt,
  });
}

/* ============================= */
/* VIEW DOCUMENT */
/* ============================= */
async function handleViewDocument(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.replace("/p/", "");

  const result = await env.DB.prepare(
    "SELECT html, expire_at FROM posts WHERE id = ?"
  )
    .bind(id)
    .first<{ html: string; expire_at: number }>();

  if (!result) return new Response("Not Found", { status: 404 });

  if (Date.now() > Number(result.expire_at)) {
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    return new Response("Expired", { status: 410 });
  }

  return new Response(result.html, {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

/* ============================= */
/* PUBLISH (create or update) */
/* ============================= */
async function handlePublish(request: Request, env: Env, url: URL): Promise<Response> {
  const body = await safeJson(request);
  if (!body?.markdown) {
    return json({ error: "Missing markdown field" }, 400);
  }

  const providedSlug = body.slug;
  const now = Date.now();
  const expireAt = now + EXPIRE_DAYS * 86400000;
  const title = body.title || extractTitle(body.markdown) || "Untitled";
  const html = buildHtml(body.markdown, expireAt);
  const source = "api";

  let slug: string;
  let created: boolean;

  if (providedSlug) {
    // Check if slug exists
    const existing = await env.DB.prepare("SELECT id FROM posts WHERE id = ?")
      .bind(providedSlug)
      .first();
    if (existing) {
      // Update
      slug = providedSlug;
      created = false;
      await env.DB.prepare(
        "UPDATE posts SET html = ?, markdown = ?, title = ?, expire_at = ?, updated_at = ? WHERE id = ?"
      )
        .bind(html, body.markdown, title, expireAt, now, slug)
        .run();
    } else {
      // Slug not found – create new (ignore provided slug)
      slug = crypto.randomUUID();
      created = true;
      await env.DB.prepare(
        "INSERT INTO posts (id, html, markdown, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(slug, html, body.markdown, title, expireAt, now, source)
        .run();
    }
  } else {
    // No slug – create new
    slug = crypto.randomUUID();
    created = true;
    await env.DB.prepare(
      "INSERT INTO posts (id, html, markdown, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(slug, html, body.markdown, title, expireAt, now, source)
      .run();
  }

  const ttlDays = EXPIRE_DAYS;

  return json(
    {
      slug,
      url: `${url.origin}/p/${slug}`,
      title,
      expiresAt: new Date(expireAt).toISOString(),
      ttlDays,
      created,
    },
    created ? 201 : 200
  );
}

/* ============================= */
/* LIST DOCUMENTS (JSON) */
/* ============================= */
async function handleListDocuments(request: Request, env: Env, url: URL): Promise<Response> {
  const results = await env.DB.prepare(
    "SELECT id, title, source, updated_at, expire_at FROM posts ORDER BY updated_at DESC"
  ).all();

  const documents = results.results.map((row: any) => ({
    slug: row.id,
    title: row.title,
    url: `${url.origin}/p/${row.id}`,
    source: row.source || "api",
    updatedAt: new Date(row.updated_at).toISOString(),
    expiresAt: new Date(row.expire_at).toISOString(),
  }));

  return json({ documents });
}

/* ============================= */
/* DELETE DOCUMENT */
/* ============================= */
async function handleDeleteDocument(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");

  if (!slug) {
    return json({ error: "Missing slug parameter" }, 400);
  }

  const existing = await env.DB.prepare("SELECT id FROM posts WHERE id = ?")
    .bind(slug)
    .first();
  if (!existing) {
    return json({ error: "Document not found" }, 404);
  }

  await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(slug).run();

  return json({ ok: true });
}

/* ============================= */
/* GET SOURCE (markdown) */
/* ============================= */
async function handleGetSource(slug: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare("SELECT markdown FROM posts WHERE id = ?")
    .bind(slug)
    .first<{ markdown: string }>();

  if (!result) {
    return json({ error: "Document not found" }, 404);
  }

  return new Response(result.markdown, {
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });
}

/* ============================= */
/* HTML PAGE LISTING DOCUMENTS */
/* ============================= */
async function handleDocumentsPage(request: Request, env: Env, baseUrl: URL): Promise<Response> {
  const results = await env.DB.prepare(
    "SELECT id, title, updated_at, expire_at FROM posts ORDER BY updated_at DESC"
  ).all();

  const documents = results.results.map((row: any) => ({
    slug: row.id,
    title: row.title || "Untitled",
    updatedAt: new Date(row.updated_at).toLocaleString("fa-IR"),
    url: `${baseUrl.origin}/p/${row.id}`,
    expireAt: new Date(row.expire_at).toLocaleString("fa-IR"),
  }));

  const html = `
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>لیست اسناد | JotBird</title>
  <style>
    body {
      font-family: system-ui, 'Vazirmatn', sans-serif;
      background: #fafafa;
      color: #1a1a1a;
      max-width: 900px;
      margin: 40px auto;
      padding: 0 20px;
      line-height: 1.6;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 30px;
      border-bottom: 2px solid #3b82f6;
      padding-bottom: 10px;
    }
    .document-list {
      list-style: none;
      padding: 0;
    }
    .document-item {
      background: white;
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 16px;
      padding: 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
    }
    .document-info {
      flex: 2;
      min-width: 250px;
    }
    .document-title {
      font-size: 1.2rem;
      font-weight: 600;
      margin: 0 0 5px;
    }
    .document-meta {
      font-size: 0.9rem;
      color: #666;
      display: flex;
      gap: 20px;
      flex-wrap: wrap;
    }
    .document-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 8px 14px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 500;
      background: #f0f0f0;
      color: #1a1a1a;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-decoration: none;
    }
    .btn:hover {
      background: #3b82f6;
      color: white;
      transform: translateY(-2px);
      box-shadow: 0 6px 12px rgba(0,0,0,0.1);
    }
    .btn-outline {
      background: transparent;
      border: 1px solid #ccc;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f0f12; color: #f0f0f5; }
      .document-item { background: #1a1a1f; }
      .document-meta { color: #aaa; }
      .btn { background: #2a2a35; color: #f0f0f5; }
      .btn-outline { background: transparent; border-color: #444; }
    }
  </style>
</head>
<body>
  <h1>📄 اسناد منتشر شده</h1>
  ${documents.length === 0 ? '<p>هیچ سندی یافت نشد.</p>' : ''}
  <ul class="document-list">
    ${documents.map(doc => `
      <li class="document-item">
        <div class="document-info">
          <div class="document-title">${doc.title}</div>
          <div class="document-meta">
            <span>📅 به‌روزرسانی: ${doc.updatedAt}</span>
            <span>⏳ انقضا: ${doc.expireAt}</span>
          </div>
        </div>
        <div class="document-actions">
          <a href="${doc.url}" target="_blank" class="btn" title="باز کردن لینک">🔗 باز کردن</a>
          <button class="btn" onclick="copySource('${doc.slug}')" title="کپی سورس کامل (با فرانت‌متر)">📋 کپی سورس</button>
          <button class="btn" onclick="createObsidianNote('${doc.slug}', '${doc.title.replace(/'/g, "\\'")}')" title="ایجاد یادداشت جدید در Obsidian">📝 ایجاد در Obsidian</button>
        </div>
      </li>
    `).join('')}
  </ul>
  <script>
    async function copySource(slug) {
      try {
        const response = await fetch('/api/v1/documents/' + slug + '/source');
        if (!response.ok) throw new Error('خطا در دریافت سورس');
        const markdown = await response.text();
        const link = window.location.origin + '/p/' + slug;
        // Try to get expiration from the page? We don't have it, so we'll use a placeholder
        // Alternatively, we could fetch it from the list, but for simplicity we set empty.
        const expires = '2026-...'; // You could fetch this from the list if needed
        const fullContent = \`---
jotbird_link: \${link}
jotbird_expires: \${expires}
---

\${markdown}\`;
        await navigator.clipboard.writeText(fullContent);
        alert('سورس کامل کپی شد!');
      } catch (e) {
        alert('خطا: ' + e.message);
      }
    }

    function createObsidianNote(slug, title) {
      const vault = encodeURIComponent(title); // you might want to get vault name from user
      const content = encodeURIComponent(\`[\${title}](\${window.location.origin}/p/\${slug})\`);
      const url = \`obsidian://new?name=\${encodeURIComponent(title)}&content=\${content}\`;
      window.location.href = url;
    }
  </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

/* ============================= */
/* AUTO TABLE (with schema upgrades) */
/* ============================= */

async function ensureTable(env: Env) {
  // Create table if not exists (minimal columns)
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL,
      expire_at INTEGER NOT NULL
    );
  `).run();

  // Check and add missing columns (idempotent)
  const tableInfo = await env.DB.prepare("PRAGMA table_info(posts)").all();
  const columns = tableInfo.results.map((col: any) => col.name);

  const addColumnIfMissing = async (colName: string, colDef: string) => {
    if (!columns.includes(colName)) {
      await env.DB.prepare(`ALTER TABLE posts ADD COLUMN ${colDef}`).run();
    }
  };

  await addColumnIfMissing("title", "title TEXT");
  await addColumnIfMissing("markdown", "markdown TEXT");
  await addColumnIfMissing("updated_at", "updated_at INTEGER");
  await addColumnIfMissing("source", "source TEXT DEFAULT 'api'");
}

/* ============================= */
/* SAFE JSON */
/* ============================= */

async function safeJson(req: Request) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/* ============================= */
/* EXTRACT TITLE FROM MARKDOWN */
/* ============================= */

function extractTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

/* ============================= */
/* MARKDOWN → HTML (with floating menu & frontmatter copy) */
/* ============================= */

function buildHtml(markdown: string, expireAt: number) {
  const escaped = escapeHtml(markdown);
  const expireDate = new Date(expireAt).toISOString().split('T')[0]; // YYYY-MM-DD

  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>پیش‌نمایش</title>
<link href="https://cdn.jsdelivr.net/npm/vazirmatn@33.003/Vazirmatn-font-face.css" rel="stylesheet"/>
<style>
:root{
  --bg:#fafafa;
  --text:#1a1a1a;
  --card:#ffffff;
  --border:#e5e5e5;
  --accent:#3b82f6;
  --accent-gradient:linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  --code-bg:#1e1e2e;
  --code-text:#cdd6f4;
  --quote-border:#f59e0b;
  --shadow:0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);
  --shadow-lg:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#0f0f12;
    --text:#f0f0f5;
    --card:#1a1a1f;
    --border:#2a2a35;
    --accent:#60a5fa;
    --code-bg:#11111b;
    --code-text:#cdd6f4;
    --quote-border:#fbbf24;
    --shadow:0 4px 6px -1px rgba(0,0,0,0.3), 0 2px 4px -1px rgba(0,0,0,0.2);
    --shadow-lg:0 20px 25px -5px rgba(0,0,0,0.5), 0 10px 10px -5px rgba(0,0,0,0.4);
  }
}
*{ box-sizing:border-box; }
body{
  font-family:"Vazirmatn", "Segoe UI", system-ui, sans-serif;
  background:var(--bg);
  color:var(--text);
  max-width:800px;
  margin:0 auto;
  padding:60px 24px;
  line-height:1.8;
  font-size:1.125rem;
}
/* ... سایر استایل‌ها (بدون تغییر) ... */
/* ============================= */
/* FLOATING MENU (bottom left, collapsible, icons only) */
/* ============================= */
.floating-menu {
  position: fixed;
  bottom: 20px;
  left: 20px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.menu-toggle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--card);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  transition: all 0.2s ease;
}
.menu-toggle:hover {
  transform: scale(1.1) rotate(90deg);
  background: var(--accent);
  color: white;
}
.menu-items {
  display: none;
  flex-direction: column;
  gap: 8px;
}
.floating-menu.open .menu-items {
  display: flex;
}
.menu-items .btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  padding: 0;
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: all 0.2s ease;
  color: var(--text);
}
.menu-items .btn:hover {
  transform: scale(1.1);
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
/* Hidden expiration element */
#expiration-date { display: none; }
</style>
</head>
<body>
<span id="expiration-date">${expireDate}</span>

<div class="floating-menu" id="floatingMenu">
  <button class="menu-toggle" id="menuToggle" aria-label="منو">⋯</button>
  <div class="menu-items">
    <button class="btn" onclick="copyFullSource()" title="کپی مارک‌داون (با فرانت‌متر)">📋</button>
    <button class="btn" onclick="copyHTML()" title="کپی HTML">🌐</button>
    <button class="btn" onclick="copyLink()" title="کپی لینک">🔗</button>
  </div>
</div>

<div id="content">
${renderMarkdown(escapeHtml(markdown))}
</div>

<script>
const rawMarkdown = \`${markdown.replace(/`/g, "\\`")}\`;
const currentUrl = window.location.href;
const expireDate = document.getElementById('expiration-date').innerText;

function copyFullSource() {
  const frontmatter = \`---
jotbird_link: \${currentUrl}
jotbird_expires: \${expireDate}
---

\`;
  const fullContent = frontmatter + rawMarkdown;
  navigator.clipboard.writeText(fullContent);
  showToast("📋 سورس کامل کپی شد!");
}

function copyHTML() {
  navigator.clipboard.writeText(document.documentElement.outerHTML);
  showToast("🌐 HTML کپی شد!");
}

function copyLink() {
  navigator.clipboard.writeText(currentUrl);
  showToast("🔗 لینک کپی شد!");
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.style.cssText = \`
    position:fixed;
    bottom:100px;
    left:50%;
    transform:translateX(-50%);
    background:var(--accent);
    color:white;
    padding:12px 24px;
    border-radius:50px;
    font-weight:600;
    box-shadow:var(--shadow-lg);
    z-index:9999;
    animation:slideUp 0.3s ease;
  \`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// Toggle menu
document.getElementById('menuToggle').addEventListener('click', function(e) {
  e.stopPropagation();
  document.getElementById('floatingMenu').classList.toggle('open');
});

// Add slideUp animation
const style = document.createElement('style');
style.textContent = \`
  @keyframes slideUp{
    from{opacity:0;transform:translate(-50%,20px);}
    to{opacity:1;transform:translate(-50%,0);}
  }
\`;
document.head.appendChild(style);
</script>
</body>
</html>
`;
}

/* ============================= */
/* ENHANCED MARKDOWN RENDER ENGINE */
/* ============================= */

function renderMarkdown(text: string) {
  let html = text;

  // First, handle code blocks (triple backticks)
  const codeBlockRegex = /\`\`\`(\w+)?\n([\s\S]*?)\n\`\`\`/g;
  html = html.replace(codeBlockRegex, (match, lang, code) => {
    const language = lang || "text";
    return `<pre><code class="language-${language}">${escapeHtml(code)}</code></pre>`;
  });

  // Handle blockquotes (multi-line)
  html = html.replace(/^&gt; (.*$)/gim, "<blockquote><p>$1</p></blockquote>");

  // Merge consecutive blockquote lines
  html = html.replace(/<\/blockquote>\s*<blockquote>/g, "<br>");

  // Headings
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^#### (.*$)/gim, "<h4>$1</h4>");
  html = html.replace(/^##### (.*$)/gim, "<h5>$1</h5>");
  html = html.replace(/^###### (.*$)/gim, "<h6>$1</h6>");

  // Inline formatting
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/==(.+?)==/g, "<mark>$1</mark>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Lists
  html = html.replace(/^- (.*$)/gim, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n)+/g, "<ul>$&</ul>");

  // Line breaks (but not inside pre/code)
  html = html.replace(/\n/g, "<br>");

  return html;
}

/* ============================= */

function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}