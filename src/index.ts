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

      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      if (url.pathname === "/publish" && request.method === "POST") {
        const body = await safeJson(request);
        if (!body?.markdown) {
          return json({ error: "markdown required" }, 400);
        }

        const id = crypto.randomUUID();
        const expireAt = Date.now() + EXPIRE_DAYS * 86400000;

        const html = buildHtml(body.markdown);

        await env.DB.prepare(
          "INSERT INTO posts (id, html, expire_at) VALUES (?, ?, ?)"
        )
          .bind(id, html, expireAt)
          .run();

        return json({
          success: true,
          url: `${url.origin}/p/${id}`,
          expireAt,
        });
      }

      if (url.pathname.startsWith("/p/")) {
        const id = url.pathname.replace("/p/", "");

        const result = await env.DB.prepare(
          "SELECT html, expire_at FROM posts WHERE id = ?"
        )
          .bind(id)
          .first();

        if (!result) return new Response("Not Found", { status: 404 });

        if (Date.now() > Number(result.expire_at)) {
          await env.DB.prepare("DELETE FROM posts WHERE id = ?")
            .bind(id)
            .run();

          return new Response("Expired", { status: 410 });
        }

        return new Response(result.html, {
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("🔥 Global Error:", err);
      return json({ error: "Internal Error" }, 500);
    }
  },
};

/* ============================= */
/* AUTO TABLE */
/* ============================= */

async function ensureTable(env: Env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL,
      expire_at INTEGER NOT NULL
    );
  `).run();
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
/* MARKDOWN → HTML (MODERN RENDERER) */
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
  --bg:#ffffff;
  --text:#111;
  --card:#f4f4f4;
  --border:#ddd;
}

@media (prefers-color-scheme: dark){
  :root{
    --bg:#0f0f0f;
    --text:#f5f5f5;
    --card:#1e1e1e;
    --border:#333;
  }
}

body{
  font-family:"Vazirmatn",sans-serif;
  background:var(--bg);
  color:var(--text);
  max-width:900px;
  margin:auto;
  padding:40px;
  line-height:1.9;
}

/* Headings */
h1,h2,h3,h4,h5,h6{
  margin-top:2rem;
  font-weight:700;
}

/* Code */
pre{
  background:var(--card);
  padding:16px;
  border-radius:12px;
  overflow:auto;
  direction:ltr;
  text-align:left;
}

code{
  background:var(--card);
  padding:4px 6px;
  border-radius:6px;
}

/* Quote */
blockquote{
  border-right:4px solid #3b82f6;
  padding-right:16px;
  opacity:0.85;
}

/* Table */
table{
  border-collapse:collapse;
  width:100%;
}

th,td{
  border:1px solid var(--border);
  padding:10px;
}

th{
  background:var(--card);
}

/* Highlight */
mark{
  background:#facc15;
  padding:2px 4px;
  border-radius:4px;
}

/* Buttons */
.btn{
  padding:10px 16px;
  border:none;
  border-radius:10px;
  cursor:pointer;
  background:#2563eb;
  color:white;
  font-weight:600;
  margin:6px;
}

.btn:hover{
  opacity:0.85;
}

.toolbar{
  position:fixed;
  top:20px;
  left:20px;
}

@media(max-width:600px){
  body{padding:20px;}
}
</style>

</head>
<body>

<div class="toolbar">
<button class="btn" onclick="copyMarkdown()">Copy Markdown</button>
<button class="btn" onclick="copyHTML()">Copy HTML</button>
<button class="btn" onclick="copyLink()">Copy Link</button>
</div>

<div id="content">
${renderMarkdown(escaped)}
</div>

<script>
const rawMarkdown = \`${markdown.replace(/`/g,"\\`")}\`;

function copyMarkdown(){
  navigator.clipboard.writeText(rawMarkdown);
  alert("Markdown Copied");
}

function copyHTML(){
  navigator.clipboard.writeText(document.documentElement.outerHTML);
  alert("HTML Copied");
}

function copyLink(){
  navigator.clipboard.writeText(location.href);
  alert("Link Copied");
}
</script>

</body>
</html>
`;
}

/* ============================= */
/* SIMPLE MARKDOWN RENDER ENGINE */
/* ============================= */

function renderMarkdown(text: string) {
  return text
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^#### (.*$)/gim, "<h4>$1</h4>")
    .replace(/^##### (.*$)/gim, "<h5>$1</h5>")
    .replace(/^###### (.*$)/gim, "<h6>$1</h6>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^> (.*$)/gim, "<blockquote>$1</blockquote>")
    .replace(/\n/g, "<br>");
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
