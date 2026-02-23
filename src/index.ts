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
  const html = buildHtml(body.markdown);

  await env.DB.prepare(
    "INSERT INTO posts (id, html, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, html, title, expireAt, Date.now(), "api")
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
  const html = buildHtml(body.markdown);
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
        "UPDATE posts SET html = ?, title = ?, expire_at = ?, updated_at = ? WHERE id = ?"
      )
        .bind(html, title, expireAt, now, slug)
        .run();
    } else {
      // Slug not found – create new (ignore provided slug)
      slug = crypto.randomUUID();
      created = true;
      await env.DB.prepare(
        "INSERT INTO posts (id, html, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(slug, html, title, expireAt, now, source)
        .run();
    }
  } else {
    // No slug – create new
    slug = crypto.randomUUID();
    created = true;
    await env.DB.prepare(
      "INSERT INTO posts (id, html, title, expire_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(slug, html, title, expireAt, now, source)
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
/* LIST DOCUMENTS */
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
/* MARKDOWN → HTML (MODERN RENDERER with floating menu) */
/* ============================= */

function buildHtml(markdown: string) {
  const escaped = escapeHtml(markdown);

  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>

<title>Preview</title>

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

*{
  box-sizing:border-box;
}

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

/* ============================= */
/* MODERN HEADINGS */
/* ============================= */

h1,h2,h3,h4,h5,h6{
  font-weight:800;
  line-height:1.3;
  margin-top:2.5rem;
  margin-bottom:1rem;
  position:relative;
  letter-spacing:-0.02em;
}

h1{
  font-size:2.5rem;
  background:var(--accent-gradient);
  -webkit-background-clip:text;
  -webkit-text-fill-color:transparent;
  background-clip:text;
  padding-bottom:0.5rem;
  border-bottom:3px solid transparent;
  border-image:var(--accent-gradient) 1;
}

h2{
  font-size:2rem;
  color:var(--text);
  padding-right:1rem;
  border-right:4px solid var(--accent);
}

h3{
  font-size:1.5rem;
  color:var(--text);
  opacity:0.9;
}

h4{
  font-size:1.25rem;
  color:var(--accent);
  font-weight:700;
}

h5{
  font-size:1.1rem;
  color:var(--text);
  opacity:0.8;
  text-transform:uppercase;
  letter-spacing:0.05em;
}

h6{
  font-size:1rem;
  color:var(--text);
  opacity:0.7;
  font-weight:600;
}

/* ============================= */
/* MODERN CODE BLOCKS */
/* ============================= */

pre{
  background:var(--code-bg);
  color:var(--code-text);
  padding:1.5rem;
  border-radius:12px;
  overflow-x:auto;
  direction:ltr;
  text-align:left;
  font-family:"JetBrains Mono", "Fira Code", "Consolas", monospace;
  font-size:0.9rem;
  line-height:1.6;
  box-shadow:var(--shadow-lg);
  border:1px solid rgba(255,255,255,0.1);
  position:relative;
  margin:1.5rem 0;
}

pre::before{
  content:"";
  position:absolute;
  top:0;
  left:0;
  right:0;
  height:40px;
  background:rgba(255,255,255,0.03);
  border-radius:12px 12px 0 0;
  border-bottom:1px solid rgba(255,255,255,0.05);
}

/* Window dots decoration */
pre::after{
  content:"● ● ●";
  position:absolute;
  top:12px;
  left:16px;
  color:#ff5f56;
  font-size:12px;
  letter-spacing:6px;
  text-shadow:16px 0 #ffbd2e, 32px 0 #27c93f;
  opacity:0.8;
}

code{
  background:rgba(59,130,246,0.1);
  color:var(--accent);
  padding:0.2em 0.4em;
  border-radius:6px;
  font-family:"JetBrains Mono", "Fira Code", monospace;
  font-size:0.85em;
  font-weight:500;
  border:1px solid rgba(59,130,246,0.2);
}

pre code{
  background:transparent;
  color:inherit;
  padding:0;
  border-radius:0;
  border:none;
  font-size:inherit;
}

/* ============================= */
/* MODERN BLOCKQUOTES */
/* ============================= */

blockquote{
  position:relative;
  margin:2rem 0;
  padding:1.5rem 2rem;
  background:var(--card);
  border-radius:12px;
  box-shadow:var(--shadow);
  border-right:none;
  border-left:4px solid var(--quote-border);
  font-style:italic;
  font-size:1.1rem;
  color:var(--text);
  opacity:0.95;
}

blockquote::before{
  content:""";
  position:absolute;
  top:-10px;
  right:20px;
  font-size:4rem;
  color:var(--quote-border);
  opacity:0.3;
  font-family:Georgia, serif;
  line-height:1;
  pointer-events:none;
}

blockquote p{
  margin:0;
  position:relative;
  z-index:1;
}

blockquote p:first-of-type::before{
  content:""";
  font-size:1.2em;
  color:var(--quote-border);
  margin-left:0.2em;
}

blockquote p:last-of-type::after{
  content:""";
  font-size:1.2em;
  color:var(--quote-border);
  margin-right:0.2em;
}

/* Attribution/Cite styling */
blockquote cite,
blockquote footer{
  display:block;
  margin-top:1rem;
  font-size:0.9rem;
  font-style:normal;
  font-weight:600;
  color:var(--accent);
  text-align:left;
}

blockquote cite::before,
blockquote footer::before{
  content:"— ";
  opacity:0.6;
}

/* ============================= */
/* OTHER ELEMENTS */
/* ============================= */

p{
  margin-bottom:1.5rem;
}

a{
  color:var(--accent);
  text-decoration:none;
  border-bottom:2px solid transparent;
  transition:all 0.2s ease;
}

a:hover{
  border-bottom-color:var(--accent);
}

/* Table */
table{
  border-collapse:separate;
  border-spacing:0;
  width:100%;
  margin:1.5rem 0;
  background:var(--card);
  border-radius:12px;
  overflow:hidden;
  box-shadow:var(--shadow);
}

th,td{
  padding:1rem;
  text-align:right;
  border-bottom:1px solid var(--border);
}

th{
  background:var(--accent-gradient);
  color:white;
  font-weight:700;
  text-transform:uppercase;
  font-size:0.85rem;
  letter-spacing:0.05em;
}

tr:last-child td{
  border-bottom:none;
}

tr:hover td{
  background:rgba(59,130,246,0.05);
}

/* Highlight */
mark{
  background:linear-gradient(120deg, #fde047 0%, #fde047 100%);
  background-repeat:no-repeat;
  background-size:100% 40%;
  background-position:0 88%;
  padding:0.2em 0.4em;
  border-radius:4px;
  color:inherit;
  font-weight:600;
}

/* Lists */
ul,ol{
  margin:1.5rem 0;
  padding-right:1.5rem;
}

li{
  margin-bottom:0.5rem;
  position:relative;
}

ul li::marker{
  color:var(--accent);
  font-size:1.2em;
}

/* Horizontal Rule */
hr{
  border:none;
  height:2px;
  background:var(--accent-gradient);
  margin:2.5rem 0;
  border-radius:2px;
  opacity:0.5;
}

/* ============================= */
/* FLOATING MENU (bottom left, collapsible) */
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
  transform: scale(1.05);
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

/* Reuse existing .btn styles for menu buttons */
.btn {
  padding: 10px 18px;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  font-size: 0.9rem;
  box-shadow: var(--shadow);
  transition: all 0.2s ease;
  border: 1px solid var(--border);
  font-family: inherit;
}

.btn:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.btn:active {
  transform: translateY(0);
}

/* Mobile adjustment */
@media (max-width: 600px) {
  body {
    padding: 80px 16px 40px;
  }
  h1 {
    font-size: 2rem;
  }
  h2 {
    font-size: 1.75rem;
  }
  pre {
    font-size: 0.8rem;
  }
  blockquote {
    padding: 1rem 1.25rem;
  }
  .floating-menu {
    bottom: 20px;
    left: 20px;
  }
}
</style>

</head>
<body>

<!-- Floating collapsible menu -->
<div class="floating-menu" id="floatingMenu">
  <button class="menu-toggle" id="menuToggle" aria-label="Menu">⋯</button>
  <div class="menu-items">
    <button class="btn" onclick="copyMarkdown()">📋 کپی Markdown</button>
    <button class="btn" onclick="copyHTML()">🌐 کپی HTML</button>
    <button class="btn" onclick="copyLink()">🔗 کپی لینک</button>
  </div>
</div>

<div id="content">
${renderMarkdown(escaped)}
</div>

<script>
const rawMarkdown = \`${markdown.replace(/`/g, "\\`")}\`;

function copyMarkdown(){
  navigator.clipboard.writeText(rawMarkdown);
  showToast("Markdown کپی شد!");
}

function copyHTML(){
  navigator.clipboard.writeText(document.documentElement.outerHTML);
  showToast("HTML کپی شد!");
}

function copyLink(){
  navigator.clipboard.writeText(location.href);
  showToast("لینک کپی شد!");
}

function showToast(message){
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
  setTimeout(()=>toast.remove(),2000);
}

// Toggle floating menu
document.getElementById('menuToggle').addEventListener('click', function(e) {
  e.stopPropagation();
  document.getElementById('floatingMenu').classList.toggle('open');
});

// Optional: close menu when clicking outside (if needed) – not implemented for simplicity

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