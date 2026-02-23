export interface Env {
  DB: D1Database;
}

const EXPIRE_DAYS = 30;

/* ===============================
   Main Worker
=================================*/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    console.log("🚀 Worker Started");
    console.log("🔍 Method:", request.method);
    console.log("🔍 URL:", request.url);

    try {
      await ensureTable(env);

      const url = new URL(request.url);

      /* ===============================
         Health Check
      =================================*/
      if (url.pathname === "/health") {
        return json({ status: "ok" });
      }

      /* ===============================
         Publish Endpoint
      =================================*/
      if (url.pathname === "/publish" && request.method === "POST") {
        const body = await safeJson(request);

        if (!body || !body.markdown) {
          return json({ error: "markdown is required" }, 400);
        }

        console.log("📝 Publishing content");

        const id = crypto.randomUUID();
        const expireAt = Date.now() + EXPIRE_DAYS * 86400000;
        const html = buildHtml(body.markdown);

        console.log("🗄 Inserting into DB");

        await env.DB.prepare(
          "INSERT INTO posts (id, html, expire_at) VALUES (?, ?, ?)"
        )
          .bind(id, html, expireAt)
          .run();

        console.log("✅ Insert success");

        return json({
          success: true,
          url: `${url.origin}/p/${id}`,
          expireAt,
        });
      }

      /* ===============================
         Get Published Page
      =================================*/
      if (url.pathname.startsWith("/p/")) {
        const id = url.pathname.replace("/p/", "");

        const result = await env.DB.prepare(
          "SELECT html, expire_at FROM posts WHERE id = ?"
        )
          .bind(id)
          .first();

        if (!result) {
          return new Response("Not Found", { status: 404 });
        }

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
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};

/* ===============================
   Auto Create Table
=================================*/

async function ensureTable(env: Env) {
  console.log("🔎 Checking table existence");

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      html TEXT NOT NULL,
      expire_at INTEGER NOT NULL
    );`
  ).run();

  console.log("✅ Table ready");
}

/* ===============================
   Safe JSON Parser
=================================*/

async function safeJson(request: Request) {
  try {
    return await request.json();
  } catch (err) {
    console.error("❌ Invalid JSON", err);
    return null;
  }
}

/* ===============================
   HTML Builder (RTL + Vazirmatn)
=================================*/

function buildHtml(markdown: string) {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link href="https://cdn.jsdelivr.net/npm/vazirmatn@33.003/Vazirmatn-font-face.css" rel="stylesheet"/>
<style>
body {
  font-family: "Vazirmatn", sans-serif;
  direction: rtl;
  text-align: right;
  padding: 40px;
  max-width: 850px;
  margin: auto;
  line-height: 1.9;
}
pre {
  direction: ltr;
  text-align: left;
  background: #f4f4f4;
  padding: 12px;
  border-radius: 8px;
}
code {
  background: #eee;
  padding: 4px 6px;
  border-radius: 6px;
}
</style>
</head>
<body>
${escapeHtml(markdown).replace(/\n/g, "<br>")}
</body>
</html>
`;
}

/* ===============================
   HTML Escape
=================================*/

function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ===============================
   JSON Response Helper
=================================*/

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
