export interface Env {
  DB: D1Database;
}

const EXPIRE_DAYS = 30;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/publish" && request.method === "POST") {
      const body = await request.json();
      const markdown = body.markdown;

      if (!markdown)
        return json({ error: "No markdown" }, 400);

      const id = crypto.randomUUID();
      const expireAt = Date.now() + EXPIRE_DAYS * 86400000;

      const html = buildHtml(markdown);

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

      if (!result)
        return new Response("Not Found", { status: 404 });

      if (Date.now() > result.expire_at) {
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
  },
};

function buildHtml(markdown: string) {
  return `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"/>
<link href="https://cdn.jsdelivr.net/npm/vazirmatn@33.003/Vazirmatn-font-face.css" rel="stylesheet">
<style>
body{
font-family:"Vazirmatn",sans-serif;
direction:rtl;
text-align:right;
padding:40px;
max-width:850px;
margin:auto;
line-height:1.9;
}
pre{direction:ltr;text-align:left;background:#f5f5f5;padding:12px;border-radius:8px}
code{background:#f5f5f5;padding:4px 6px;border-radius:6px}
</style>
</head>
<body>
${markdown.replace(/\n/g,"<br>")}
</body>
</html>`;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function scheduled(
  _event: ScheduledEvent,
  env: Env
) {
  await env.DB.prepare(
    "DELETE FROM posts WHERE expire_at < ?"
  )
    .bind(Date.now())
    .run();
}
