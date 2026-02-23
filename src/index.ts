export interface Env {
  BUCKET: R2Bucket;
  META: KVNamespace;
}

const EXPIRE_DAYS = 30;
const FONT_URL =
  "https://cdn.jsdelivr.net/npm/vazirmatn@33.003/Vazirmatn-font-face.css";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/publish" && request.method === "POST") {
      return handlePublish(request, env);
    }

    if (url.pathname.startsWith("/p/")) {
      return handleGet(url.pathname.replace("/p/", ""), env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handlePublish(request: Request, env: Env) {
  const body = await request.json();
  const markdown = body.markdown;

  if (!markdown) {
    return json({ error: "No markdown provided" }, 400);
  }

  const id = crypto.randomUUID();
  const expireAt = Date.now() + EXPIRE_DAYS * 24 * 60 * 60 * 1000;

  const html = buildHtml(markdown);

  await env.BUCKET.put(`${id}.html`, html, {
    httpMetadata: { contentType: "text/html; charset=UTF-8" },
  });

  await env.META.put(id, JSON.stringify({ expireAt }));

  return json({
    success: true,
    url: `${request.headers.get("origin")}/p/${id}`,
    expireAt,
  });
}

async function handleGet(id: string, env: Env) {
  const metaRaw = await env.META.get(id);

  if (!metaRaw) {
    return new Response("Expired or Not Found", { status: 404 });
  }

  const meta = JSON.parse(metaRaw);

  if (Date.now() > meta.expireAt) {
    await env.BUCKET.delete(`${id}.html`);
    await env.META.delete(id);
    return new Response("Expired", { status: 410 });
  }

  const object = await env.BUCKET.get(`${id}.html`);

  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(object.body, {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

function buildHtml(markdown: string): string {
  const escaped = markdown
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link href="${FONT_URL}" rel="stylesheet">
<style>
body {
  font-family: "Vazirmatn", sans-serif;
  direction: rtl;
  text-align: right;
  background: #ffffff;
  color: #111;
  line-height: 1.9;
  padding: 40px;
  max-width: 850px;
  margin: auto;
}
h1,h2,h3,h4,h5,h6 {
  margin-top: 1.8em;
}
code {
  background: #f5f5f5;
  padding: 4px 6px;
  border-radius: 6px;
}
pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  direction: ltr;
  text-align: left;
}
a {
  color: #2563eb;
}
</style>
</head>
<body>
${escaped}
</body>
</html>`;
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}