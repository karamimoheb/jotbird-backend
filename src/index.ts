/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MarkPub Worker — Cloudflare Workers + D1                                  */
/*  v2.1.0 · Auto-migrate DB · Rich Markdown · Debug Panel · RTL support     */
/* ═══════════════════════════════════════════════════════════════════════════ */

export interface Env {
  DB: D1Database;
}

/* ─── Constants ─────────────────────────────────────────────────────────── */
const EXPIRE_DAYS = 30;
const WORKER_VER  = "2.1.0";
const SCHEMA_VER  = 3; // bump whenever a migration is added

const CORS: HeadersInit = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Debug",
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  LOGGER — structured, leveled, per-request                                 */
/* ═══════════════════════════════════════════════════════════════════════════ */
type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
type LogEntry = { ts: number; level: LogLevel; msg: string; data?: unknown };

class Logger {
  private reqId: string;
  private logs: LogEntry[] = [];

  constructor(reqId: string) { this.reqId = reqId; }

  private write(level: LogLevel, msg: string, data?: unknown) {
    this.logs.push({ ts: Date.now(), level, msg, data });
    const p = `[${level}][${this.reqId}]`;
    if      (level === "ERROR") console.error(p, msg, data ?? "");
    else if (level === "WARN")  console.warn(p,  msg, data ?? "");
    else                        console.log(p,   msg, data ?? "");
  }

  debug(msg: string, data?: unknown) { this.write("DEBUG", msg, data); }
  info (msg: string, data?: unknown) { this.write("INFO",  msg, data); }
  warn (msg: string, data?: unknown) { this.write("WARN",  msg, data); }
  error(msg: string, data?: unknown) { this.write("ERROR", msg, data); }
  dump()  { return this.logs; }
  id()    { return this.reqId; }
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  DB MIGRATION SYSTEM                                                        */
/*  Each migration is idempotent — safe to run on every cold start.           */
/* ═══════════════════════════════════════════════════════════════════════════ */
const MIGRATIONS: Array<{ ver: number; label: string; sql: string }> = [
  {
    ver: 1, label: "create_posts",
    sql: `CREATE TABLE IF NOT EXISTS posts (
      id        TEXT    PRIMARY KEY,
      html      TEXT    NOT NULL,
      expire_at INTEGER NOT NULL
    )`,
  },
  {
    ver: 2, label: "add_title",
    sql: `ALTER TABLE posts ADD COLUMN title TEXT DEFAULT 'Untitled'`,
  },
  {
    ver: 2, label: "add_word_count",
    sql: `ALTER TABLE posts ADD COLUMN word_count INTEGER DEFAULT 0`,
  },
  {
    ver: 3, label: "add_created_at",
    sql: `ALTER TABLE posts ADD COLUMN created_at INTEGER DEFAULT (unixepoch() * 1000)`,
  },
];

async function runMigrations(
  env: Env,
  log: Logger
): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [];
  const skipped: string[] = [];

  // Bootstrap version-tracking table
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY,
      label   TEXT    NOT NULL,
      ran_at  INTEGER NOT NULL
    )
  `).run();

  const applied = await env.DB
    .prepare("SELECT version FROM schema_versions")
    .all<{ version: number }>();
  const appliedSet = new Set((applied.results ?? []).map(r => r.version));

  log.debug("DB migration state", {
    applied: [...appliedSet],
    target: SCHEMA_VER,
  });

  for (const m of MIGRATIONS) {
    const key = `v${m.ver}:${m.label}`;
    try {
      await env.DB.prepare(m.sql).run();
      ran.push(key);
      log.info(`Migration OK: ${key}`);
    } catch (err: any) {
      const msg: string = err?.message ?? "";
      if (
        msg.includes("duplicate column") ||
        msg.includes("already exists") ||
        msg.includes("table") // "table posts already exists" for CREATE IF NOT EXISTS variants
      ) {
        skipped.push(key);
        log.debug(`Migration skipped (already applied): ${key}`);
      } else {
        log.error(`Migration FAILED: ${key}`, { sql: m.sql, error: msg });
        throw new Error(`Migration [${key}] failed: ${msg}`);
      }
    }

    // Track version
    if (!appliedSet.has(m.ver)) {
      try {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO schema_versions (version, label, ran_at) VALUES (?, ?, ?)"
        ).bind(m.ver, m.label, Date.now()).run();
        appliedSet.add(m.ver);
      } catch { /* non-fatal */ }
    }
  }

  return { ran, skipped };
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MAIN FETCH HANDLER                                                         */
/* ═══════════════════════════════════════════════════════════════════════════ */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const reqId     = crypto.randomUUID().slice(0, 8).toUpperCase();
    const log       = new Logger(reqId);
    const startMs   = Date.now();
    const url       = new URL(request.url);
    const { pathname } = url;
    const debugMode = request.headers.get("X-Debug") === "1" ||
                      url.searchParams.has("__debug");

    log.info("Request", {
      method:    request.method,
      pathname,
      ua:        request.headers.get("user-agent")?.slice(0, 80),
      colo:      (request as any).cf?.colo ?? "local",
    });

    // CORS preflight
    if (request.method === "OPTIONS") {
      log.debug("CORS preflight OK");
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      /* ── Run migrations on every request (idempotent, fast after first run) */
      const migrations = await runMigrations(env, log);

      /* ── Router ──────────────────────────────────────────────────────────── */

      if (request.method === "GET"  && pathname === "/health")
        return handleHealth(env, log, startMs, migrations);

      if (request.method === "GET"  && pathname === "/debug")
        return handleDebug(env, log, request, startMs);

      if (request.method === "POST" && pathname === "/publish")
        return handlePublish(request, env, url, log, debugMode, startMs);

      // UUID v4 pattern
      const postMatch = pathname.match(
        /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      );
      if (request.method === "GET" && postMatch)
        return handleView(postMatch[1], env, log, debugMode);

      if (request.method === "GET" && (pathname === "/" || pathname === ""))
        return htmlResponse(buildHomePage());

      log.warn("No route matched", { pathname, method: request.method });
      return notFound(pathname);

    } catch (err: any) {
      log.error("Unhandled exception", {
        message: err?.message,
        stack:   err?.stack?.split("\n").slice(0, 6),
      });
      return jsonResponse({
        error:   "Internal Server Error",
        reqId,
        elapsed: `${Date.now() - startMs}ms`,
        ...(debugMode ? { debug: log.dump() } : {}),
      }, 500);
    }
  },
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  ROUTE HANDLERS                                                             */
/* ═══════════════════════════════════════════════════════════════════════════ */

async function handleHealth(
  env: Env,
  log: Logger,
  startMs: number,
  migrations: { ran: string[]; skipped: string[] }
): Promise<Response> {
  log.debug("Health check");
  let dbOk = false, dbMs = 0, postCount = 0;

  try {
    const t0  = Date.now();
    const row = await env.DB.prepare("SELECT COUNT(*) as n FROM posts")
      .first<{ n: number }>();
    dbMs      = Date.now() - t0;
    dbOk      = true;
    postCount = row?.n ?? 0;
  } catch (err: any) {
    log.error("DB ping failed", err?.message);
  }

  return jsonResponse({
    status:        dbOk ? "ok" : "degraded",
    version:       WORKER_VER,
    schemaVersion: SCHEMA_VER,
    timestamp:     Date.now(),
    elapsed:       `${Date.now() - startMs}ms`,
    database:      { ok: dbOk, pingMs: dbMs, postCount, migrations },
  });
}

async function handleDebug(
  env: Env,
  log: Logger,
  request: Request,
  startMs: number
): Promise<Response> {
  if (request.headers.get("X-Debug") !== "1") {
    return jsonResponse(
      { error: "Forbidden. Add header X-Debug: 1 to access diagnostics." },
      403
    );
  }

  log.info("Debug endpoint hit");
  let tableInfo: unknown, recentPosts: unknown, schemaVersions: unknown;

  try {
    tableInfo = await env.DB.prepare("PRAGMA table_info(posts)").all();
  } catch (e: any) { tableInfo = { error: e?.message }; }

  try {
    recentPosts = await env.DB.prepare(
      "SELECT id, title, word_count, expire_at, created_at FROM posts ORDER BY created_at DESC LIMIT 10"
    ).all();
  } catch (e: any) { recentPosts = { error: e?.message }; }

  try {
    schemaVersions = await env.DB
      .prepare("SELECT * FROM schema_versions ORDER BY version")
      .all();
  } catch (e: any) { schemaVersions = { error: e?.message }; }

  return jsonResponse({
    worker:   { version: WORKER_VER, schemaVersion: SCHEMA_VER },
    elapsed:  `${Date.now() - startMs}ms`,
    database: { tableInfo, recentPosts, schemaVersions },
    logs:     log.dump(),
  });
}

async function handlePublish(
  request: Request,
  env: Env,
  url: URL,
  log: Logger,
  debugMode: boolean,
  startMs: number
): Promise<Response> {
  log.debug("Parsing body");

  const body = await safeJson<{ markdown?: string; title?: string }>(request);
  if (!body) {
    log.warn("Bad JSON body");
    return jsonResponse({ error: "Invalid or empty JSON body", reqId: log.id() }, 400);
  }

  const raw = body.markdown;
  if (!raw || typeof raw !== "string") {
    log.warn("Missing markdown", { keys: Object.keys(body) });
    return jsonResponse({ error: "`markdown` field is required (string)", reqId: log.id() }, 400);
  }

  const markdown = raw.trim();
  if (!markdown) {
    return jsonResponse({ error: "`markdown` must not be empty", reqId: log.id() }, 400);
  }
  if (markdown.length > 500_000) {
    log.warn("Markdown too large", { bytes: markdown.length });
    return jsonResponse({ error: "Markdown exceeds 500 KB limit", reqId: log.id() }, 413);
  }

  const id        = crypto.randomUUID();
  const expireAt  = Date.now() + EXPIRE_DAYS * 86_400_000;
  const title     = (body.title?.trim() || extractTitle(markdown) || "Untitled").slice(0, 200);
  const wordCount = countWords(markdown);

  log.debug("Rendering HTML", { id, title, wordCount });
  let html: string;
  try {
    html = buildArticlePage(markdown, title, url.origin);
  } catch (err: any) {
    log.error("Render failed", err?.message);
    return jsonResponse({ error: "Failed to render markdown", reqId: log.id() }, 500);
  }

  log.debug("Inserting post", { id, htmlLen: html.length });
  try {
    await env.DB.prepare(
      "INSERT INTO posts (id, html, expire_at, title, word_count, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, html, expireAt, title, wordCount, Date.now()).run();
  } catch (err: any) {
    log.error("DB insert failed", { error: err?.message });
    return jsonResponse({
      error:  "Database write failed",
      detail: err?.message,
      reqId:  log.id(),
    }, 500);
  }

  const elapsed = Date.now() - startMs;
  log.info("Published", { id, title, wordCount, elapsed });

  return jsonResponse({
    success:   true,
    reqId:     log.id(),
    id,
    url:       `${url.origin}/p/${id}`,
    title,
    wordCount,
    expireAt,
    expiresIn: `${EXPIRE_DAYS} days`,
    elapsed:   `${elapsed}ms`,
    ...(debugMode ? { debug: log.dump() } : {}),
  });
}

async function handleView(
  id: string,
  env: Env,
  log: Logger,
  debugMode: boolean
): Promise<Response> {
  log.debug("Fetching post", { id });

  let result: { html: string; expire_at: number; title: string } | null = null;
  try {
    result = await env.DB.prepare(
      "SELECT html, expire_at, title FROM posts WHERE id = ?"
    ).bind(id).first<{ html: string; expire_at: number; title: string }>();
  } catch (err: any) {
    log.error("DB select failed", { error: err?.message });
    return htmlResponse(
      buildErrorPage("500", "Database Error", "Could not load the post.", log.id()),
      500
    );
  }

  if (!result) {
    log.warn("Post not found", { id });
    return htmlResponse(
      buildErrorPage("404", "Post Not Found", "This post doesn't exist or was already deleted.", log.id()),
      404
    );
  }

  if (Date.now() > Number(result.expire_at)) {
    log.info("Post expired — deleting", { id });
    try {
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
    } catch (err: any) {
      log.warn("Cleanup failed", err?.message);
    }
    return htmlResponse(
      buildErrorPage("410", "Post Expired", "This post has expired and been removed.", log.id()),
      410
    );
  }

  log.info("Serving post", { id, title: result.title });
  return new Response(result.html, {
    headers: {
      "Content-Type":  "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=300, stale-while-revalidate=60",
      "X-Request-Id":  log.id(),
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  MARKDOWN RENDERER                                                          */
/* ═══════════════════════════════════════════════════════════════════════════ */
function renderMarkdown(raw: string): string {
  // 1. Stash fenced code blocks before any escaping
  const codeBlocks: string[] = [];
  let md = raw.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang
      ? `<span class="code-lang">${escapeAttr(lang)}</span>`
      : "";
    const block = `<pre class="code-block">${langLabel}<code${lang ? ` class="language-${escapeAttr(lang)}"` : ""}>${escapeHtml(code.trimEnd())}</code></pre>`;
    codeBlocks.push(block);
    return `\x00CODE${codeBlocks.length - 1}\x00`;
  });

  // 2. Escape remaining HTML
  md = escapeHtml(md);

  // 3. Horizontal rules
  md = md.replace(/^(---|\*\*\*|___)[ \t]*$/gm, "<hr>");

  // 4. Headings
  md = md
    .replace(/^###### (.+)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.+)$/gm,  "<h5>$1</h5>")
    .replace(/^#### (.+)$/gm,   "<h4>$1</h4>")
    .replace(/^### (.+)$/gm,    "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,     "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,      "<h1>$1</h1>");

  // 5. Blockquotes (note: > is escaped to &gt;)
  md = md.replace(/^&gt; (.+)$/gm, "<blockquote><p>$1</p></blockquote>");

  // 6. Unordered lists
  md = md.replace(/((?:^[-*+] .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n")
      .map(l => `<li>${l.replace(/^[-*+] /, "")}</li>`).join("");
    return `<ul>${items}</ul>`;
  });

  // 7. Ordered lists
  md = md.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split("\n")
      .map(l => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `<ol>${items}</ol>`;
  });

  // 8. Tables (pipe-delimited)
  md = md.replace(/(\|.+\|\n\|[-:| ]+\|\n(?:\|.+\|\n?)*)/g, (table) => {
    const rows   = table.trim().split("\n");
    const header = rows[0].split("|").filter(Boolean)
      .map(c => `<th>${c.trim()}</th>`).join("");
    const body   = rows.slice(2).map(r =>
      `<tr>${r.split("|").filter(Boolean).map(c => `<td>${c.trim()}</td>`).join("")}</tr>`
    ).join("");
    return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  });

  // 9. Inline styles (images first, then links)
  md = md
    .replace(/!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g,
      '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g,     "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g,         "<em>$1</em>")
    .replace(/~~(.+?)~~/g,         "<del>$1</del>")
    .replace(/`([^`\n]+)`/g,       "<code>$1</code>");

  // 10. Paragraphs (bare text lines not already wrapped in a block tag)
  md = md.replace(
    /^(?!<(?:h[1-6]|ul|ol|li|blockquote|pre|hr|div|table|thead|tbody|tr|th|td|p)[> \n/])(.*\S.*)$/gm,
    "<p>$1</p>"
  );

  // 11. Clean empty paragraphs
  md = md.replace(/<p>\s*<\/p>/g, "");

  // 12. Restore code blocks
  md = md.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return md;
}

function extractTitle(md: string): string | null {
  const m = md.match(/^# (.+)$/m);
  return m ? m[1].replace(/[*_`#]/g, "").trim() : null;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  DESIGN SYSTEM                                                              */
/* ═══════════════════════════════════════════════════════════════════════════ */
const FONTS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;0,9..40,900;1,9..40,400&family=Lora:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const CSS = `
:root{
  --bg:#080a0c;--surface:#0f1114;--surface2:#171a1f;--surface3:#1e2229;
  --border:#252933;--border2:#2f3542;
  --accent:#5eead4;--accent2:#38bdf8;--accent3:#a78bfa;
  --text:#e2e8f0;--text2:#94a3b8;--muted:#64748b;
  --danger:#f87171;--success:#34d399;
  --ff-sans:'DM Sans',system-ui,sans-serif;
  --ff-mono:'JetBrains Mono','Fira Code',monospace;
  --ff-serif:'Lora',Georgia,serif;
  --r:12px;--r-sm:8px;--r-xs:5px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--text);font-family:var(--ff-sans);line-height:1.7;min-height:100vh;-webkit-font-smoothing:antialiased}
::selection{background:rgba(94,234,212,.22);color:var(--text)}
a{color:var(--accent2);text-decoration:none;transition:color .15s}
a:hover{color:#7dd3fc;text-decoration:underline}
img{max-width:100%;border-radius:var(--r);display:block}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--surface)}
::-webkit-scrollbar-thumb{background:var(--border2);border-radius:99px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}

/* NAV */
nav{
  position:sticky;top:0;z-index:200;
  backdrop-filter:blur(24px) saturate(180%);
  -webkit-backdrop-filter:blur(24px) saturate(180%);
  background:rgba(8,10,12,.88);
  border-bottom:1px solid var(--border);
  padding:0 max(1.5rem,env(safe-area-inset-left));
  display:flex;align-items:center;justify-content:space-between;
  height:58px;gap:1rem
}
.logo{
  display:flex;align-items:center;gap:.55rem;
  font-weight:800;font-size:1.05rem;letter-spacing:-.025em;
  color:var(--text);text-decoration:none;flex-shrink:0
}
.logo:hover{text-decoration:none}
.logo svg{width:30px;height:30px;flex-shrink:0}
.logo-accent{color:var(--accent)}
.nav-actions{display:flex;align-items:center;gap:.5rem}

/* BUTTONS */
.btn{
  display:inline-flex;align-items:center;gap:.45rem;
  padding:.5rem 1.15rem;border-radius:var(--r-sm);
  font-size:.85rem;font-weight:600;cursor:pointer;
  border:none;transition:all .15s ease;font-family:var(--ff-sans);
  white-space:nowrap;user-select:none
}
.btn svg{flex-shrink:0}
.btn-primary{background:var(--accent);color:#0a1a18}
.btn-primary:hover{background:#4dd8c2;transform:translateY(-1px);box-shadow:0 6px 24px rgba(94,234,212,.25)}
.btn-primary:active{transform:translateY(0)}
.btn-ghost{background:var(--surface2);color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover{background:var(--surface3);border-color:var(--border2)}
.icon-btn{
  display:inline-flex;align-items:center;gap:.38rem;
  padding:.38rem .8rem;border-radius:var(--r-xs);
  font-size:.78rem;font-weight:500;cursor:pointer;
  background:var(--surface2);color:var(--text2);
  border:1px solid var(--border);transition:all .15s;
  font-family:var(--ff-sans);white-space:nowrap
}
.icon-btn:hover{color:var(--text);background:var(--surface3);border-color:var(--border2)}
.icon-btn.active{color:var(--accent);border-color:rgba(94,234,212,.4);background:rgba(94,234,212,.08)}
.icon-btn svg{flex-shrink:0}

/* READING PROGRESS */
#reading-progress{
  position:fixed;top:58px;left:0;right:0;height:2px;z-index:199;
  background:linear-gradient(90deg,var(--accent),var(--accent2));
  transform-origin:left;transform:scaleX(0);transition:transform .1s linear
}

/* ARTICLE */
.article-outer{max-width:780px;margin:0 auto;padding:2.5rem 1.5rem 6rem}
.article-header{margin-bottom:2rem;padding-bottom:1.5rem;border-bottom:1px solid var(--border)}
.article-toolbar{
  display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:.75rem;margin-bottom:1.25rem
}
.meta-pills{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.pill{
  display:inline-flex;align-items:center;gap:.3rem;
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text2);padding:.22rem .65rem;border-radius:100px;font-size:.75rem
}
.pill svg{width:11px;height:11px}
.action-bar{display:flex;gap:.4rem;flex-wrap:wrap}
.expiry-notice{
  display:flex;align-items:center;gap:.6rem;
  background:rgba(94,234,212,.05);border:1px solid rgba(94,234,212,.15);
  border-radius:var(--r-sm);padding:.6rem 1rem;font-size:.78rem;color:var(--accent);
  margin-bottom:1.5rem
}
.expiry-notice svg{flex-shrink:0}
.expiry-notice strong{color:#7ef7e8}

/* CONTENT */
.content{font-family:var(--ff-serif);font-size:1.07rem;color:#c8d0df}
.content h1{
  font-family:var(--ff-sans);font-size:clamp(1.75rem,4vw,2.4rem);
  font-weight:900;letter-spacing:-.035em;line-height:1.15;margin-bottom:1.25rem;
  color:var(--text);background:linear-gradient(135deg,#e2e8f0 40%,#94a3b8);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text
}
.content h2{
  font-family:var(--ff-sans);font-size:1.45rem;font-weight:800;
  letter-spacing:-.02em;line-height:1.25;color:var(--text);
  margin:2.75rem 0 .9rem;padding-left:.9rem;border-left:3px solid var(--accent)
}
.content h3{font-family:var(--ff-sans);font-size:1.15rem;font-weight:700;margin:2rem 0 .65rem;color:var(--text)}
.content h4,.content h5,.content h6{font-family:var(--ff-sans);font-weight:600;margin:1.5rem 0 .5rem;color:var(--text)}
.content p{margin-bottom:1.2rem}
.content strong{color:var(--text);font-weight:700}
.content em{font-style:italic;color:#b8c4d8}
.content del{color:var(--muted);text-decoration:line-through}
.content hr{border:none;border-top:1px solid var(--border);margin:2.5rem 0}
.content ul{list-style:none;margin:.75rem 0 1.25rem;padding:0}
.content ul li{position:relative;padding-left:1.4rem;margin-bottom:.45rem;color:#b8c4d8}
.content ul li::before{content:'';position:absolute;left:0;top:.65em;width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.75}
.content ol{margin:.75rem 0 1.25rem 1.5rem}
.content ol li{margin-bottom:.45rem;color:#b8c4d8}
.content blockquote{
  margin:1.75rem 0;padding:.9rem 1.25rem;
  border-left:3px solid var(--accent3);
  background:rgba(167,139,250,.06);border-radius:0 var(--r-sm) var(--r-sm) 0;
  color:var(--text2);font-style:italic
}
.content blockquote p{margin:0}
.content code{
  font-family:var(--ff-mono);font-size:.83em;
  background:var(--surface2);color:var(--accent2);
  padding:.12em .42em;border-radius:4px;border:1px solid var(--border)
}
.content pre.code-block{
  position:relative;margin:1.75rem 0;
  background:#060809;border:1px solid var(--border);
  border-radius:var(--r);padding:1.25rem 1.5rem;overflow-x:auto
}
.content pre.code-block code{
  background:none;border:none;padding:0;
  font-size:.85rem;color:#9ab;display:block;line-height:1.75;
  -webkit-text-fill-color:unset
}
.code-lang{
  position:absolute;top:.55rem;right:.75rem;
  font-family:var(--ff-mono);font-size:.65rem;font-weight:500;
  color:var(--muted);text-transform:uppercase;letter-spacing:.1em;
  background:var(--surface3);padding:.15rem .45rem;border-radius:3px
}
.content .table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:var(--r);margin:1.5rem 0}
.content table{width:100%;border-collapse:collapse;font-size:.88rem}
.content th{
  background:var(--surface2);text-align:left;padding:.6rem 1rem;
  font-family:var(--ff-sans);font-weight:700;font-size:.75rem;
  text-transform:uppercase;letter-spacing:.07em;color:var(--text2);
  border-bottom:1px solid var(--border)
}
.content td{padding:.55rem 1rem;border-bottom:1px solid var(--border);color:#b8c4d8}
.content tr:last-child td{border-bottom:none}
.content tr:nth-child(even) td{background:rgba(255,255,255,.015)}
.content a{color:var(--accent2)}
.content img{margin:1.5rem auto;border:1px solid var(--border)}

/* ERROR PAGE */
.error-page{
  min-height:100vh;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  text-align:center;padding:2rem
}
.error-glyph{
  font-size:5.5rem;font-weight:900;line-height:1;
  font-family:var(--ff-sans);letter-spacing:-.05em;
  background:linear-gradient(135deg,var(--surface3),var(--border2));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;
  margin-bottom:.5rem
}
.error-title{font-size:1.35rem;font-weight:700;margin-bottom:.6rem}
.error-msg{color:var(--text2);max-width:340px;margin-bottom:.5rem;font-size:.9rem}
.error-reqid{color:var(--muted);font-size:.72rem;font-family:var(--ff-mono);margin-bottom:1.75rem}
.error-icon{margin-bottom:1.5rem;color:var(--danger);opacity:.6}

/* HOME PAGE */
.hero{
  position:relative;overflow:hidden;
  min-height:calc(100vh - 58px);
  display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  text-align:center;padding:5rem 1.5rem
}
.hero-bg{
  position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(ellipse 70% 50% at 50% -10%,rgba(94,234,212,.1) 0%,transparent 60%),
    radial-gradient(ellipse 50% 40% at 80% 110%,rgba(56,189,248,.07) 0%,transparent 55%),
    radial-gradient(ellipse 30% 30% at 10% 80%,rgba(167,139,250,.06) 0%,transparent 50%)
}
.hero-grid{
  position:absolute;inset:0;pointer-events:none;
  background-image:linear-gradient(var(--border) 1px,transparent 1px),
    linear-gradient(90deg,var(--border) 1px,transparent 1px);
  background-size:48px 48px;opacity:.3;
  mask-image:radial-gradient(ellipse 80% 60% at 50% 0%,black 0%,transparent 70%)
}
.hero-badge{
  display:inline-flex;align-items:center;gap:.45rem;
  background:var(--surface2);border:1px solid var(--border2);
  padding:.3rem 1rem;border-radius:100px;
  font-size:.75rem;color:var(--text2);margin-bottom:2rem;position:relative
}
.badge-dot{width:7px;height:7px;border-radius:50%;background:var(--success);flex-shrink:0;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.85)}}
.badge-accent{color:var(--accent);font-weight:700}
.hero h1{
  font-size:clamp(2.8rem,8vw,5rem);font-weight:900;
  letter-spacing:-.045em;line-height:1.05;margin-bottom:1.4rem;
  max-width:720px;position:relative
}
.hero h1 em{
  font-style:normal;
  background:linear-gradient(135deg,var(--accent) 0%,var(--accent2) 100%);
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text
}
.hero p{color:var(--text2);font-size:1.1rem;max-width:500px;margin-bottom:2.5rem;position:relative}
.hero-cta{display:flex;gap:.75rem;flex-wrap:wrap;justify-content:center;position:relative}
.hero-stat{display:flex;gap:2.5rem;margin-top:3.5rem;position:relative}
.stat{text-align:center}
.stat-val{font-size:1.8rem;font-weight:900;letter-spacing:-.04em;color:var(--text)}
.stat-label{font-size:.73rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}

/* HOME SECTIONS */
.home-section{max-width:900px;margin:0 auto;padding:0 1.5rem 5rem}
.section-eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.14em;color:var(--accent);font-weight:700;margin-bottom:.75rem}
.section-heading{font-size:1.8rem;font-weight:800;letter-spacing:-.025em;margin-bottom:2.25rem}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:1rem}
.feature-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r);padding:1.35rem;transition:border-color .2s,transform .2s
}
.feature-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.feat-icon{
  width:40px;height:40px;border-radius:var(--r-sm);
  display:flex;align-items:center;justify-content:center;margin-bottom:1rem
}
.feat-icon.teal{background:rgba(94,234,212,.1);color:var(--accent)}
.feat-icon.blue{background:rgba(56,189,248,.1);color:var(--accent2)}
.feat-icon.purple{background:rgba(167,139,250,.1);color:var(--accent3)}
.feat-icon.green{background:rgba(52,211,153,.1);color:var(--success)}
.feat-icon svg{width:20px;height:20px}
.feature-card h4{font-size:.92rem;font-weight:700;margin-bottom:.35rem}
.feature-card p{font-size:.8rem;color:var(--text2);line-height:1.6}
.api-cards{display:grid;gap:.85rem}
.api-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--r);padding:1.4rem;transition:border-color .2s
}
.api-card:hover{border-color:var(--border2)}
.api-card-top{display:flex;align-items:center;gap:.65rem;margin-bottom:.65rem}
.method{font-family:var(--ff-mono);font-size:.72rem;font-weight:700;padding:.22rem .6rem;border-radius:4px}
.method-post{background:rgba(94,234,212,.12);color:var(--accent)}
.method-get{background:rgba(56,189,248,.12);color:var(--accent2)}
.endpoint{font-family:var(--ff-mono);font-size:.88rem}
.api-card>p{font-size:.85rem;color:var(--text2);margin-bottom:1rem}
.code-snippet{
  background:#060809;border:1px solid var(--border);
  border-radius:var(--r-sm);padding:1rem 1.2rem;
  font-family:var(--ff-mono);font-size:.78rem;color:#8a9ab8;
  white-space:pre-wrap;overflow-x:auto;line-height:1.7
}
footer{
  text-align:center;padding:2rem 1.5rem;
  color:var(--muted);font-size:.78rem;border-top:1px solid var(--border)
}

/* RTL */
[dir="rtl"] .content h2{padding-left:0;padding-right:.9rem;border-left:none;border-right:3px solid var(--accent)}
[dir="rtl"] .content ul li{padding-left:0;padding-right:1.4rem}
[dir="rtl"] .content ul li::before{left:auto;right:0}
[dir="rtl"] .content blockquote{border-left:none;border-right:3px solid var(--accent3);border-radius:var(--r-sm) 0 0 var(--r-sm)}

@media(max-width:640px){
  .hero h1{font-size:2.6rem}
  .hero-stat{gap:1.5rem}
  .icon-btn span{display:none}
  .article-outer{padding:1.5rem 1rem 5rem}
  .content h1{font-size:1.7rem}
  .content h2{font-size:1.2rem}
}
@media print{
  nav,.action-bar,.expiry-notice,#reading-progress{display:none!important}
  body{background:#fff;color:#000}
  .content h1{-webkit-text-fill-color:#000}
}`;

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  SVG ICON LIBRARY                                                           */
/* ═══════════════════════════════════════════════════════════════════════════ */
const I = {
  logo: `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="9" fill="url(#lg)"/>
    <path d="M8 10h16M8 16h11M8 22h13" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
    <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
      <stop stop-color="#5eead4"/><stop offset="1" stop-color="#38bdf8"/>
    </linearGradient></defs>
  </svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  words: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>`,
  link:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
  copy:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  share: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`,
  print: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
  warn:  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  zap:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  globe: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  db:    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  key:   `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
};

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  HTML PAGE BUILDERS                                                         */
/* ═══════════════════════════════════════════════════════════════════════════ */
function baseHead(title: string, desc = ""): string {
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  ${desc ? `<meta name="description" content="${escapeAttr(desc)}">` : ""}
  <meta name="theme-color" content="#080a0c">
  ${FONTS}
  <style>${CSS}</style>`;
}

function buildNav(extra = ""): string {
  return `<nav>
    <a class="logo" href="/" aria-label="MarkPub Home">
      ${I.logo}
      Mark<span class="logo-accent">Pub</span>
    </a>
    <div class="nav-actions">${extra}</div>
  </nav>`;
}

function buildHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>${baseHead("MarkPub — Publish Markdown Instantly", "POST your markdown, get a shareable URL. No auth, no friction.")}</head>
<body>
${buildNav()}
<section class="hero">
  <div class="hero-bg"></div>
  <div class="hero-grid"></div>
  <div class="hero-badge">
    <span class="badge-dot"></span>
    Running on <span class="badge-accent">Cloudflare Workers</span> · Edge-first
  </div>
  <h1>Publish <em>Markdown</em><br>to the web instantly</h1>
  <p>One API call. A shareable URL. Auto-expiry. Zero accounts required.</p>
  <div class="hero-cta">
    <a class="btn btn-primary" href="#api">${I.zap} API Docs</a>
    <a class="btn btn-ghost" href="#features">Learn More</a>
  </div>
  <div class="hero-stat">
    <div class="stat"><div class="stat-val">1</div><div class="stat-label">API Call</div></div>
    <div class="stat"><div class="stat-val">30d</div><div class="stat-label">Auto-Expiry</div></div>
    <div class="stat"><div class="stat-val">0ms</div><div class="stat-label">Setup Time</div></div>
  </div>
</section>

<section class="home-section" id="features">
  <p class="section-eyebrow">Features</p>
  <p class="section-heading">Everything you need, nothing you don't</p>
  <div class="feature-grid">
    <div class="feature-card"><div class="feat-icon teal">${I.zap}</div><h4>Instant Publishing</h4><p>POST markdown, receive a URL. No build steps, no dashboards.</p></div>
    <div class="feature-card"><div class="feat-icon blue">${I.globe}</div><h4>Globally Distributed</h4><p>Served from Cloudflare's edge network — fast everywhere.</p></div>
    <div class="feature-card"><div class="feat-icon purple">${I.clock}</div><h4>Auto-Expiry</h4><p>Posts auto-delete after 30 days. No cleanup needed on your end.</p></div>
    <div class="feature-card"><div class="feat-icon green">${I.db}</div><h4>Durable Storage</h4><p>Backed by Cloudflare D1 — serverless SQLite at the edge.</p></div>
    <div class="feature-card"><div class="feat-icon teal">${I.words}</div><h4>Rich Markdown</h4><p>Headings, tables, code blocks, images, and full RTL support.</p></div>
    <div class="feature-card"><div class="feat-icon blue">${I.key}</div><h4>Full Debug API</h4><p>Hit /debug with X-Debug:1 for complete diagnostics anytime.</p></div>
  </div>
</section>

<section class="home-section" id="api">
  <p class="section-eyebrow">API Reference</p>
  <p class="section-heading">Simple REST interface</p>
  <div class="api-cards">
    <div class="api-card">
      <div class="api-card-top"><span class="method method-post">POST</span><span class="endpoint">/publish</span></div>
      <p>Publish a new markdown post. Returns a shareable URL and metadata.</p>
      <div class="code-snippet">curl -X POST https://your-worker.dev/publish \
  -H "Content-Type: application/json" \
  -d '{"markdown":"# Hello\n\nWorld","title":"Hello"}'

// Response 200
{
  "success": true, "id": "550e8400-...", "reqId": "A3F7C1B2",
  "url": "https://your-worker.dev/p/550e8400-...",
  "title": "Hello", "wordCount": 2,
  "expireAt": 1774445872077, "expiresIn": "30 days", "elapsed": "38ms"
}</div>
    </div>
    <div class="api-card">
      <div class="api-card-top"><span class="method method-get">GET</span><span class="endpoint">/p/:uuid</span></div>
      <p>View a published post as a rendered HTML page. Returns 410 if expired.</p>
      <div class="code-snippet">curl https://your-worker.dev/p/550e8400-e29b-41d4-a716-446655440000
// → Returns rendered HTML with copy/share/print actions</div>
    </div>
    <div class="api-card">
      <div class="api-card-top"><span class="method method-get">GET</span><span class="endpoint">/health</span></div>
      <p>Health check. Returns DB status, post count, migration state, and latency.</p>
      <div class="code-snippet">{ "status": "ok", "version": "2.1.0", "database": { "ok": true, "pingMs": 4, "postCount": 42 } }</div>
    </div>
    <div class="api-card">
      <div class="api-card-top"><span class="method method-get">GET</span><span class="endpoint">/debug</span></div>
      <p>Full diagnostic dump — requires <code>X-Debug: 1</code> header. Shows schema, recent posts, migration history, and full request logs.</p>
      <div class="code-snippet">curl /debug -H "X-Debug: 1"
// → { worker, database: { tableInfo, recentPosts, schemaVersions }, logs }</div>
    </div>
  </div>
</section>

<footer>
  Built on <strong style="color:var(--text2)">Cloudflare Workers</strong> + <strong style="color:var(--text2)">D1</strong>
  &nbsp;·&nbsp;Posts expire after ${EXPIRE_DAYS} days&nbsp;·&nbsp;v${WORKER_VER}
</footer>
</body>
</html>`;
}

function buildArticlePage(markdown: string, title: string, origin: string): string {
  const content    = renderMarkdown(markdown);
  const wordCount  = countWords(markdown);
  const readTime   = Math.max(1, Math.round(wordCount / 200));
  const expireDate = new Date(Date.now() + EXPIRE_DAYS * 86_400_000).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  // Auto-detect RTL (Arabic/Persian/Hebrew/Urdu scripts)
  const isRTL = /[\u0600-\u06FF\u0750-\u077F\u0590-\u05FF]/.test(markdown.slice(0, 300));

  return `<!DOCTYPE html>
<html lang="${isRTL ? "fa" : "en"}" dir="${isRTL ? "rtl" : "ltr"}">
<head>
  ${baseHead(`${title} · MarkPub`, markdown.slice(0, 155).replace(/[#*`\n]/g, " ").trim())}
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:type" content="article">
</head>
<body>
${buildNav(`<button class="icon-btn" onclick="window.print()">${I.print} <span>Print</span></button>`)}
<div id="reading-progress"></div>
<main class="article-outer">
  <div class="article-header">
    <div class="article-toolbar">
      <div class="meta-pills">
        <span class="pill">${I.clock} ${readTime} min read</span>
        <span class="pill">${I.words} ${wordCount.toLocaleString()} words</span>
      </div>
      <div class="action-bar">
        <button class="icon-btn" id="btn-md"    onclick="cp('md')">${I.copy} <span>Markdown</span></button>
        <button class="icon-btn" id="btn-html"  onclick="cp('html')">${I.copy} <span>HTML</span></button>
        <button class="icon-btn" id="btn-link"  onclick="cp('link')">${I.link} <span>Link</span></button>
        <button class="icon-btn" id="btn-share" onclick="shr()">${I.share} <span>Share</span></button>
      </div>
    </div>
    <div class="expiry-notice">
      ${I.clock}
      <span>Expires on <strong>${expireDate}</strong> — auto-deleted after ${EXPIRE_DAYS} days</span>
    </div>
  </div>
  <article class="content" id="post-content">${content}</article>
</main>
<script>
  const RAW=${JSON.stringify(markdown)};
  const bar=document.getElementById('reading-progress');
  window.addEventListener('scroll',()=>{
    const d=document.documentElement;
    bar.style.transform='scaleX('+Math.min(1,d.scrollTop/(d.scrollHeight-d.clientHeight))+')';
  },{passive:true});
  async function cp(type){
    const ids={md:'btn-md',html:'btn-html',link:'btn-link'};
    const btn=document.getElementById(ids[type]);
    const text=type==='md'?RAW:type==='html'?document.getElementById('post-content').innerHTML:location.href;
    try{
      await navigator.clipboard.writeText(text);
      const orig=btn.innerHTML;
      btn.innerHTML=btn.innerHTML.replace(/<svg[\\s\\S]*?<\\/svg>/,\`${I.check}\`);
      btn.classList.add('active');
      setTimeout(()=>{btn.innerHTML=orig;btn.classList.remove('active');},2000);
    }catch{alert('Copy failed — please copy manually.');}
  }
  async function shr(){
    if(navigator.share){try{await navigator.share({title:document.title,url:location.href});return;}catch{}}
    cp('link');
  }
</script>
</body>
</html>`;
}

function buildErrorPage(code: string, title: string, msg: string, reqId = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>${baseHead(`${code} · MarkPub`)}</head>
<body>
${buildNav()}
<div class="error-page">
  <div class="error-icon">${I.warn}</div>
  <div class="error-glyph">${code}</div>
  <div class="error-title">${escapeHtml(title)}</div>
  <p class="error-msg">${escapeHtml(msg)}</p>
  ${reqId ? `<p class="error-reqid">Request ID: ${escapeHtml(reqId)}</p>` : ""}
  <a class="btn btn-primary" href="/">← Back to Home</a>
</div>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  UTILITIES                                                                  */
/* ═══════════════════════════════════════════════════════════════════════════ */
async function safeJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; }
  catch { return null; }
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str: string): string {
  return String(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...CORS },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

function notFound(path = ""): Response {
  return htmlResponse(
    buildErrorPage("404", "Page Not Found", `"${path}" doesn't exist on this server.`),
    404
  );
}
