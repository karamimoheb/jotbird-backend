export interface Env {
  DB: D1Database;
}

const EXPIRE_DAYS = 30;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/* ═══════════════════════════════════════════════════════════ */
/*  ROUTER                                                      */
/* ═══════════════════════════════════════════════════════════ */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      await ensureTable(env);
      const url = new URL(request.url);
      const { pathname } = url;

      // Health check
      if (pathname === "/health") {
        return jsonResponse({ status: "ok", timestamp: Date.now() });
      }

      // Publish markdown
      if (pathname === "/publish" && request.method === "POST") {
        return handlePublish(request, env, url);
      }

      // View post
      const postMatch = pathname.match(/^\/p\/([a-f0-9-]{36})$/);
      if (postMatch) {
        return handleView(postMatch[1], env);
      }

      // Home page
      if (pathname === "/" || pathname === "") {
        return new Response(buildHomePage(), {
          headers: { "Content-Type": "text/html; charset=UTF-8" },
        });
      }

      return notFound();
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },
};

/* ═══════════════════════════════════════════════════════════ */
/*  HANDLERS                                                    */
/* ═══════════════════════════════════════════════════════════ */
async function handlePublish(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const body = await safeJson<{ markdown?: string; title?: string }>(request);

  if (!body?.markdown) {
    return jsonResponse({ error: "markdown field is required" }, 400);
  }

  const id = crypto.randomUUID();
  const expireAt = Date.now() + EXPIRE_DAYS * 86_400_000;
  const title = body.title?.trim() || extractTitle(body.markdown) || "Untitled";
  const html = buildArticlePage(body.markdown, title, url.origin);
  const wordCount = body.markdown.trim().split(/\s+/).length;

  await env.DB.prepare(
    "INSERT INTO posts (id, html, expire_at, title, word_count) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, html, expireAt, title, wordCount)
    .run();

  return jsonResponse({
    success: true,
    id,
    url: `${url.origin}/p/${id}`,
    title,
    wordCount,
    expireAt,
    expiresIn: `${EXPIRE_DAYS} days`,
  });
}

async function handleView(id: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT html, expire_at FROM posts WHERE id = ?"
  )
    .bind(id)
    .first<{ html: string; expire_at: number }>();

  if (!result) {
    return new Response(buildErrorPage("404", "Post Not Found", "This post doesn't exist or has been removed."), {
      status: 404,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  if (Date.now() > Number(result.expire_at)) {
    await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    return new Response(buildErrorPage("410", "Post Expired", "This post has expired and is no longer available."), {
      status: 410,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  return new Response(result.html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/* ═══════════════════════════════════════════════════════════ */
/*  DATABASE                                                    */
/* ═══════════════════════════════════════════════════════════ */
async function ensureTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS posts (
      id         TEXT    PRIMARY KEY,
      html       TEXT    NOT NULL,
      expire_at  INTEGER NOT NULL,
      title      TEXT    DEFAULT 'Untitled',
      word_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
  `).run();
}

/* ═══════════════════════════════════════════════════════════ */
/*  MARKDOWN RENDERER                                           */
/* ═══════════════════════════════════════════════════════════ */
function renderMarkdown(md: string): string {
  let html = escapeHtml(md);

  // Fenced code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : "";
    return `<pre class="code-block">${langLabel}<code class="${lang ? `language-${lang}` : ""}">${code.trimEnd()}</code></pre>`;
  });

  // Horizontal rule
  html = html.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, "<hr>");

  // Headings
  html = html
    .replace(/^###### (.+)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.+)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  html = html.replace(/(^[-*+] .+\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*+] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/(^\d+\. .+\n?)+/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Tables
  html = html.replace(/(\|.+\|\n\|[-:| ]+\|\n(?:\|.+\|\n?)*)/g, (table) => {
    const rows = table.trim().split('\n');
    const header = rows[0].split('|').filter(Boolean).map(c => `<th>${c.trim()}</th>`).join('');
    const body = rows.slice(2).map(r =>
      `<tr>${r.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`).join('')}</tr>`
    ).join('');
    return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  });

  // Inline: bold, italic, strikethrough, inline-code, links, images
  html = html
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs — wrap bare lines
  html = html.replace(/^(?!<[a-z])(.*\S.*)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

function extractTitle(md: string): string | null {
  const match = md.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}

/* ═══════════════════════════════════════════════════════════ */
/*  HTML PAGES                                                  */
/* ═══════════════════════════════════════════════════════════ */
const CSS = `
  :root {
    --bg: #0c0d0f;
    --surface: #141518;
    --surface2: #1c1e23;
    --border: #2a2d35;
    --accent: #6ee7b7;
    --accent2: #38bdf8;
    --text: #e8eaf0;
    --muted: #7c8494;
    --danger: #f87171;
    --font-sans: 'DM Sans', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    --font-serif: 'Lora', Georgia, serif;
    --radius: 12px;
    --shadow: 0 4px 24px rgba(0,0,0,.5);
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    line-height: 1.7;
    min-height: 100vh;
  }
  a { color: var(--accent2); text-decoration: none; }
  a:hover { text-decoration: underline; }
  img { max-width: 100%; border-radius: var(--radius); }

  /* NAV */
  nav {
    position: sticky; top: 0; z-index: 100;
    backdrop-filter: blur(20px) saturate(180%);
    background: rgba(12,13,15,.85);
    border-bottom: 1px solid var(--border);
    padding: 0 1.5rem;
    display: flex; align-items: center; justify-content: space-between;
    height: 56px;
  }
  .logo {
    display: flex; align-items: center; gap: .6rem;
    font-weight: 700; font-size: 1.1rem; letter-spacing: -.02em;
    color: var(--text); text-decoration: none;
  }
  .logo svg { width: 28px; height: 28px; }
  .logo-dot { color: var(--accent); }

  /* BUTTONS */
  .btn {
    display: inline-flex; align-items: center; gap: .4rem;
    padding: .5rem 1.1rem; border-radius: 8px; font-size: .875rem;
    font-weight: 500; cursor: pointer; border: none; transition: all .15s;
    font-family: var(--font-sans);
  }
  .btn-primary {
    background: var(--accent); color: #0c1a14;
  }
  .btn-primary:hover { background: #5ad4a4; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(110,231,183,.3); }
  .btn-ghost {
    background: var(--surface2); color: var(--text); border: 1px solid var(--border);
  }
  .btn-ghost:hover { background: var(--border); }
  .btn-icon {
    background: var(--surface2); color: var(--muted); border: 1px solid var(--border);
    padding: .4rem .7rem; border-radius: 6px; font-size: .8rem;
    cursor: pointer; transition: all .15s; font-family: var(--font-sans);
    display: inline-flex; align-items: center; gap: .35rem;
  }
  .btn-icon:hover { color: var(--text); background: var(--border); }
  .btn-icon.copied { color: var(--accent); border-color: var(--accent); }

  /* ARTICLE */
  .article-wrap {
    max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem 6rem;
  }
  .article-meta {
    display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
    color: var(--muted); font-size: .82rem; margin-bottom: 2.5rem;
    padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
  }
  .meta-chip {
    display: inline-flex; align-items: center; gap: .35rem;
    background: var(--surface2); border: 1px solid var(--border);
    padding: .25rem .7rem; border-radius: 100px; font-size: .78rem;
  }
  .meta-chip svg { width: 13px; height: 13px; }
  .article-actions {
    display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 2rem;
  }

  /* MARKDOWN CONTENT */
  .content { font-family: var(--font-serif); font-size: 1.08rem; }
  .content h1 {
    font-family: var(--font-sans); font-size: 2.2rem; font-weight: 800;
    line-height: 1.2; letter-spacing: -.03em; margin-bottom: 1.5rem;
    background: linear-gradient(135deg, var(--text), var(--muted));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .content h2 {
    font-family: var(--font-sans); font-size: 1.5rem; font-weight: 700;
    margin: 2.5rem 0 1rem; color: var(--text);
    display: flex; align-items: center; gap: .5rem;
  }
  .content h2::before {
    content: ''; display: block; width: 4px; height: 1.2em;
    background: var(--accent); border-radius: 2px; flex-shrink: 0;
  }
  .content h3 { font-family: var(--font-sans); font-size: 1.2rem; font-weight: 600; margin: 2rem 0 .75rem; }
  .content h4, .content h5, .content h6 { font-family: var(--font-sans); margin: 1.5rem 0 .5rem; }
  .content p { margin-bottom: 1.25rem; color: #c8cad4; }
  .content strong { color: var(--text); font-weight: 700; }
  .content em { font-style: italic; }
  .content del { color: var(--muted); text-decoration: line-through; }
  .content hr { border: none; border-top: 1px solid var(--border); margin: 2.5rem 0; }
  .content ul, .content ol { margin: 1rem 0 1.25rem 1.5rem; }
  .content li { margin-bottom: .4rem; color: #c8cad4; }
  .content blockquote {
    border-left: 3px solid var(--accent); margin: 1.5rem 0;
    padding: .75rem 1.25rem; background: var(--surface2); border-radius: 0 8px 8px 0;
    color: var(--muted); font-style: italic;
  }
  .content code {
    font-family: var(--font-mono); font-size: .85em;
    background: var(--surface2); padding: .15em .4em;
    border-radius: 4px; color: var(--accent2); border: 1px solid var(--border);
  }
  .content pre.code-block {
    background: #0a0b0d; border: 1px solid var(--border);
    border-radius: var(--radius); padding: 1.25rem 1.5rem;
    overflow-x: auto; margin: 1.5rem 0; position: relative;
  }
  .content pre.code-block code {
    background: none; border: none; padding: 0;
    font-size: .875rem; color: #adb5c9; display: block; line-height: 1.7;
  }
  .code-lang {
    position: absolute; top: .6rem; right: .8rem;
    font-family: var(--font-mono); font-size: .7rem;
    color: var(--muted); text-transform: uppercase; letter-spacing: .08em;
  }
  .content table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; font-size: .9rem; }
  .content th {
    background: var(--surface2); text-align: left; padding: .6rem 1rem;
    font-family: var(--font-sans); font-weight: 600; font-size: .82rem;
    text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
    border: 1px solid var(--border);
  }
  .content td { padding: .6rem 1rem; border: 1px solid var(--border); color: #c8cad4; }
  .content tr:nth-child(even) td { background: rgba(255,255,255,.02); }
  .table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); }
  .table-wrap table { margin: 0; }

  /* EXPIRY BADGE */
  .expiry-bar {
    display: flex; align-items: center; gap: .5rem;
    background: rgba(110,231,183,.06); border: 1px solid rgba(110,231,183,.15);
    border-radius: 8px; padding: .6rem 1rem; margin-bottom: 2rem;
    font-size: .8rem; color: var(--accent);
  }
  .expiry-bar svg { flex-shrink: 0; }

  /* ERROR PAGE */
  .error-wrap {
    min-height: 100vh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center; padding: 2rem;
  }
  .error-code {
    font-size: 7rem; font-weight: 900; line-height: 1;
    background: linear-gradient(135deg, var(--surface2), var(--border));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    font-family: var(--font-sans); letter-spacing: -.04em;
  }
  .error-title { font-size: 1.5rem; font-weight: 700; margin: .5rem 0 .75rem; }
  .error-msg { color: var(--muted); max-width: 360px; margin-bottom: 2rem; }

  /* HOME PAGE */
  .hero {
    min-height: calc(100vh - 56px);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 4rem 1.5rem;
    background:
      radial-gradient(ellipse 60% 40% at 50% 0%, rgba(110,231,183,.08) 0%, transparent 70%),
      radial-gradient(ellipse 40% 30% at 80% 80%, rgba(56,189,248,.06) 0%, transparent 60%);
  }
  .hero-badge {
    display: inline-flex; align-items: center; gap: .4rem;
    background: var(--surface2); border: 1px solid var(--border);
    padding: .3rem .9rem; border-radius: 100px; font-size: .78rem;
    color: var(--muted); margin-bottom: 2rem;
  }
  .hero-badge span { color: var(--accent); font-weight: 600; }
  .hero h1 {
    font-size: clamp(2.5rem, 7vw, 4.5rem); font-weight: 900;
    letter-spacing: -.04em; line-height: 1.1; margin-bottom: 1.25rem;
    max-width: 700px;
  }
  .hero h1 .grad {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .hero p { color: var(--muted); font-size: 1.1rem; max-width: 480px; margin-bottom: 2.5rem; }
  .hero-cta { display: flex; gap: .75rem; flex-wrap: wrap; justify-content: center; }

  /* API CARD */
  .api-section {
    max-width: 860px; margin: 0 auto; padding: 0 1.5rem 6rem;
  }
  .section-label {
    font-size: .75rem; text-transform: uppercase; letter-spacing: .12em;
    color: var(--accent); font-weight: 700; margin-bottom: 1rem;
  }
  .section-title {
    font-size: 1.75rem; font-weight: 800; letter-spacing: -.02em; margin-bottom: 2.5rem;
  }
  .cards { display: grid; gap: 1rem; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 1.5rem; transition: border-color .2s;
  }
  .card:hover { border-color: var(--accent); }
  .card-header {
    display: flex; align-items: center; gap: .75rem; margin-bottom: .75rem;
  }
  .method-tag {
    font-family: var(--font-mono); font-size: .75rem; font-weight: 700;
    padding: .2rem .6rem; border-radius: 5px;
  }
  .method-post { background: rgba(110,231,183,.15); color: var(--accent); }
  .method-get { background: rgba(56,189,248,.15); color: var(--accent2); }
  .endpoint { font-family: var(--font-mono); font-size: .9rem; color: var(--text); }
  .card p { color: var(--muted); font-size: .9rem; margin-bottom: 1rem; }
  .code-snippet {
    background: #0a0b0d; border: 1px solid var(--border); border-radius: 8px;
    padding: 1rem 1.25rem; font-family: var(--font-mono); font-size: .8rem;
    color: #adb5c9; white-space: pre-wrap; overflow-x: auto; position: relative;
  }
  .features {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem; margin-top: 1rem;
  }
  .feature-item {
    display: flex; align-items: flex-start; gap: .75rem; padding: 1rem;
    background: var(--surface2); border-radius: 8px; border: 1px solid var(--border);
  }
  .feature-icon {
    width: 36px; height: 36px; border-radius: 8px;
    background: rgba(110,231,183,.1); display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .feature-icon svg { width: 18px; height: 18px; color: var(--accent); }
  .feature-text h4 { font-size: .875rem; font-weight: 600; margin-bottom: .2rem; }
  .feature-text p { font-size: .8rem; color: var(--muted); }

  @media (max-width: 600px) {
    .article-actions { gap: .35rem; }
    .btn-icon span { display: none; }
  }
`;

const FONTS = `
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800;900&family=Lora:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
`;

const SVGS = {
  logo: `<svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="28" height="28" rx="8" fill="#6ee7b7" fill-opacity=".15"/>
    <path d="M7 9h14M7 14h10M7 19h12" stroke="#6ee7b7" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>`,
  words: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>`,
  link: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  copy: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>`,
  share: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  print: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6,9 6,2 18,2 18,9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
};

function buildNav(extra = ""): string {
  return `
  <nav>
    <a class="logo" href="/">
      ${SVGS.logo}
      Mark<span class="logo-dot">Pub</span>
    </a>
    <div style="display:flex;gap:.5rem;align-items:center;">
      ${extra}
    </div>
  </nav>`;
}

function buildHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MarkPub — Publish Markdown Instantly</title>
  ${FONTS}
  <style>${CSS}</style>
</head>
<body>
  ${buildNav()}

  <section class="hero">
    <div class="hero-badge">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>
      <span>Live</span> · Powered by Cloudflare Workers + D1
    </div>
    <h1>Publish <span class="grad">Markdown</span><br>to the web instantly</h1>
    <p>POST your markdown, get a shareable URL back. No accounts, no friction, zero setup.</p>
    <div class="hero-cta">
      <a class="btn btn-primary" href="#api">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></svg>
        View API Docs
      </a>
      <a class="btn btn-ghost" href="#features">Explore Features</a>
    </div>
  </section>

  <section class="api-section" id="features">
    <p class="section-label">Features</p>
    <div class="features">
      <div class="feature-item">
        <div class="feature-icon">${SVGS.clock}</div>
        <div class="feature-text">
          <h4>Auto-Expiry</h4>
          <p>Posts expire after 30 days and are cleaned up automatically.</p>
        </div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">${SVGS.link}</div>
        <div class="feature-text">
          <h4>Instant URLs</h4>
          <p>Get a permanent shareable URL immediately after publishing.</p>
        </div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">${SVGS.copy}</div>
        <div class="feature-text">
          <h4>Copy Actions</h4>
          <p>Copy markdown, HTML source, or the post URL with one click.</p>
        </div>
      </div>
      <div class="feature-item">
        <div class="feature-icon">${SVGS.words}</div>
        <div class="feature-text">
          <h4>Rich Markdown</h4>
          <p>Tables, code blocks, blockquotes, images, and more.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="api-section" id="api">
    <p class="section-label">API Reference</p>
    <p class="section-title">Simple REST Interface</p>
    <div class="cards">
      <div class="card">
        <div class="card-header">
          <span class="method-tag method-post">POST</span>
          <span class="endpoint">/publish</span>
        </div>
        <p>Publish a new markdown post. Returns a shareable URL.</p>
        <div class="code-snippet">curl -X POST /publish \\
  -H "Content-Type: application/json" \\
  -d '{
    "markdown": "# Hello World\\n\\nMy first post.",
    "title": "Hello World"
  }'

// Response
{
  "success": true,
  "url": "https://your-worker.dev/p/&lt;id&gt;",
  "title": "Hello World",
  "wordCount": 5,
  "expireAt": 1234567890000,
  "expiresIn": "30 days"
}</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="method-tag method-get">GET</span>
          <span class="endpoint">/p/:id</span>
        </div>
        <p>View a published post as a fully rendered HTML page.</p>
        <div class="code-snippet">curl /p/550e8400-e29b-41d4-a716-446655440000
// → Returns rendered HTML page</div>
      </div>
      <div class="card">
        <div class="card-header">
          <span class="method-tag method-get">GET</span>
          <span class="endpoint">/health</span>
        </div>
        <p>Health check endpoint returns status and timestamp.</p>
        <div class="code-snippet">{ "status": "ok", "timestamp": 1234567890000 }</div>
      </div>
    </div>
  </section>

  <footer style="text-align:center;padding:2rem;color:var(--muted);font-size:.8rem;border-top:1px solid var(--border);">
    Built on Cloudflare Workers &amp; D1 · Posts expire after 30 days
  </footer>
</body>
</html>`;
}

function buildArticlePage(markdown: string, title: string, origin: string): string {
  const content = renderMarkdown(markdown);
  const wordCount = markdown.trim().split(/\s+/).length;
  const readTime = Math.max(1, Math.round(wordCount / 200));
  const expireDate = new Date(Date.now() + EXPIRE_DAYS * 86_400_000).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} · MarkPub</title>
  <meta name="description" content="${escapeHtml(markdown.slice(0, 160).replace(/\n/g, ' '))}">
  ${FONTS}
  <style>${CSS}
    @media print {
      nav, .article-actions, .expiry-bar { display: none !important; }
      body { background: white; color: black; }
    }
  </style>
</head>
<body>
  ${buildNav(`<button class="btn-icon" onclick="window.print()" title="Print">${SVGS.print} <span>Print</span></button>`)}

  <main class="article-wrap">
    <div class="article-meta">
      <span class="meta-chip">${SVGS.clock} ${readTime} min read</span>
      <span class="meta-chip">${SVGS.words} ${wordCount.toLocaleString()} words</span>
      <span style="margin-left:auto">Published via MarkPub</span>
    </div>

    <div class="expiry-bar">
      ${SVGS.clock}
      This post expires on <strong style="margin-left:.25rem">${expireDate}</strong>
    </div>

    <div class="article-actions">
      <button class="btn-icon" id="btn-copy-md" onclick="copyContent('markdown')" title="Copy Markdown">
        ${SVGS.copy} <span>Copy Markdown</span>
      </button>
      <button class="btn-icon" id="btn-copy-html" onclick="copyContent('html')" title="Copy HTML">
        ${SVGS.copy} <span>Copy HTML</span>
      </button>
      <button class="btn-icon" id="btn-copy-link" onclick="copyContent('link')" title="Copy Link">
        ${SVGS.link} <span>Copy Link</span>
      </button>
      <button class="btn-icon" onclick="sharePost()" title="Share">
        ${SVGS.share} <span>Share</span>
      </button>
    </div>

    <article class="content" id="article-content">
      ${content}
    </article>
  </main>

  <script>
    const RAW_MARKDOWN = ${JSON.stringify(markdown)};

    async function copyContent(type) {
      let text = '';
      const btnId = type === 'markdown' ? 'btn-copy-md' : type === 'html' ? 'btn-copy-html' : 'btn-copy-link';
      const btn = document.getElementById(btnId);

      if (type === 'markdown') text = RAW_MARKDOWN;
      else if (type === 'html') text = document.getElementById('article-content').innerHTML;
      else text = window.location.href;

      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.innerHTML;
        btn.innerHTML = btn.innerHTML.replace(/<svg[^>]*>.*?<\\/svg>/, \`${SVGS.check}\`);
        btn.classList.add('copied');
        setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 2000);
      } catch(e) { alert('Copy failed. Please copy manually.'); }
    }

    async function sharePost() {
      if (navigator.share) {
        navigator.share({ title: document.title, url: window.location.href });
      } else {
        copyContent('link');
      }
    }
  </script>
</body>
</html>`;
}

function buildErrorPage(code: string, title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${code} · MarkPub</title>
  ${FONTS}
  <style>${CSS}</style>
</head>
<body>
  ${buildNav()}
  <div class="error-wrap">
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" style="margin-bottom:1.5rem">
      <circle cx="36" cy="36" r="35" stroke="#2a2d35" stroke-width="2"/>
      <path d="M36 22v16M36 46v4" stroke="#f87171" stroke-width="3" stroke-linecap="round"/>
    </svg>
    <div class="error-code">${code}</div>
    <div class="error-title">${title}</div>
    <p class="error-msg">${message}</p>
    <a class="btn btn-primary" href="/">← Back to Home</a>
  </div>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════ */
/*  UTILITIES                                                   */
/* ═══════════════════════════════════════════════════════════ */
async function safeJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function notFound(): Response {
  return new Response(
    buildErrorPage("404", "Page Not Found", "The page you're looking for doesn't exist."),
    { status: 404, headers: { "Content-Type": "text/html; charset=UTF-8" } }
  );
}
