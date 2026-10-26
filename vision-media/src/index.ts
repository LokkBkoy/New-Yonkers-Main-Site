interface Env {
  MEDIA: R2Bucket;
  UPLOAD_SHARED_SECRET: string;
}

type UploadGrant = {
  expiresAt: number;
  deviceSerial: string;
  characterIdentifier: string;
};

const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
const GRANT_LIFETIME_SECONDS = 30;
const HOST = "https://vision.newyonkers.org";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "600",
};

function json(data: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders,
      ...extra,
    },
  });
}

function text(body: string, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders,
    },
  });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request: Request, env: Env) {
  const configured = env.UPLOAD_SHARED_SECRET || "";
  if (configured.length < 32) return false;
  const auth = request.headers.get("Authorization") || "";
  return safeEqual(auth, `Bearer ${configured}`);
}

function randomToken(bytes = 32) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return [...data].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function isSafeIdentifier(value: unknown, max: number) {
  return typeof value === "string" && value.length >= 1 && value.length <= max && /^[A-Za-z0-9:_\-.]+$/.test(value);
}

async function createUploadSession(request: Request, env: Env) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!isSafeIdentifier(body?.deviceSerial, 96) || !isSafeIdentifier(body?.characterIdentifier, 128)) {
    return json({ error: "Invalid device metadata" }, 400);
  }

  const token = randomToken(32);
  const grant: UploadGrant = {
    expiresAt: Date.now() + GRANT_LIFETIME_SECONDS * 1000,
    deviceSerial: body.deviceSerial,
    characterIdentifier: body.characterIdentifier,
  };

  await env.MEDIA.put(`grants/${token}.json`, JSON.stringify(grant), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { kind: "upload-grant" },
  });

  return json({
    uploadURL: `${HOST}/upload/${token}`,
    field: "file",
    expiresIn: GRANT_LIFETIME_SECONDS,
  });
}

async function consumeUpload(request: Request, env: Env, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "Invalid upload token" }, 401);

  const key = `grants/${token}.json`;
  const grantObject = await env.MEDIA.get(key);
  if (!grantObject) return json({ error: "Invalid or expired upload token" }, 401);

  await env.MEDIA.delete(key);

  let grant: UploadGrant;
  try {
    grant = JSON.parse(await grantObject.text()) as UploadGrant;
  } catch {
    return json({ error: "Invalid upload grant" }, 401);
  }
  if (!grant.expiresAt || Date.now() > grant.expiresAt) return json({ error: "Upload token expired" }, 401);

  const declaredLength = Number(request.headers.get("Content-Length") || "0");
  if (declaredLength > MAX_UPLOAD_BYTES + 128 * 1024) return json({ error: "Upload too large" }, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart form data" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Image field not found" }, 400);
  if (file.size < 4 || file.size > MAX_UPLOAD_BYTES) return json({ error: "Upload too large" }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return json({ error: "Only JPEG screenshots are accepted" }, 415);
  }

  const id = crypto.randomUUID().replaceAll("-", "");
  const mediaKey = `media/${id}.jpg`;
  await env.MEDIA.put(mediaKey, bytes, {
    httpMetadata: { contentType: "image/jpeg", cacheControl: "private, max-age=86400" },
    customMetadata: {
      deviceSerial: grant.deviceSerial,
      characterIdentifier: grant.characterIdentifier,
      uploadedAt: new Date().toISOString(),
    },
  });

  return json({ url: `${HOST}/media/${id}.jpg`, id });
}

async function serveMedia(env: Env, id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) return json({ error: "Media not found" }, 404);
  const object = await env.MEDIA.get(`media/${id}.jpg`);
  if (!object) return json({ error: "Media not found" }, 404);

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "image/jpeg");
  headers.set("Cache-Control", "private, max-age=86400");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `inline; filename="kingx-vision-${id}.jpg"`);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

async function deleteMedia(request: Request, env: Env, id: string) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!/^[a-f0-9]{32}$/.test(id)) return json({ error: "Invalid media id" }, 400);
  await env.MEDIA.delete(`media/${id}.jpg`);
  return json({ ok: true });
}

const statusPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KINGX Vision Media · New Yonkers</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090c;color:#f6f7fb}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 25% 15%,rgba(120,100,255,.22),transparent 34%),radial-gradient(circle at 80% 75%,rgba(68,186,255,.16),transparent 36%),#08090c}.orb{position:fixed;width:36rem;height:36rem;border-radius:50%;filter:blur(90px);opacity:.17;pointer-events:none}.a{background:#765cff;top:-15rem;left:-10rem}.b{background:#41c8ff;right:-16rem;bottom:-18rem}.card{width:min(720px,calc(100vw - 32px));padding:42px;border:1px solid rgba(255,255,255,.14);border-radius:32px;background:rgba(255,255,255,.075);backdrop-filter:blur(28px) saturate(150%);box-shadow:0 30px 100px rgba(0,0,0,.5),inset 0 1px rgba(255,255,255,.16)}.brand{display:flex;align-items:center;gap:14px;margin-bottom:30px}.mark{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:linear-gradient(145deg,#fff,#b5c6ff);color:#111;font-weight:900;box-shadow:0 12px 32px rgba(152,172,255,.28)}h1{font-size:clamp(32px,6vw,58px);line-height:.96;letter-spacing:-.055em;margin:0 0 18px;max-width:600px}p{margin:0;color:#b8bdc9;font-size:16px;line-height:1.65}.status{display:flex;align-items:center;gap:10px;margin:28px 0 30px;padding:14px 16px;width:max-content;border-radius:999px;background:rgba(83,242,150,.09);border:1px solid rgba(83,242,150,.18);color:#c7ffdc;font-weight:700}.dot{width:9px;height:9px;border-radius:50%;background:#53f296;box-shadow:0 0 0 6px rgba(83,242,150,.1)}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.tile{padding:18px;border:1px solid rgba(255,255,255,.08);border-radius:20px;background:rgba(255,255,255,.045)}.tile strong{display:block;font-size:13px;color:#fff;margin-bottom:5px}.tile span{font-size:12px;color:#8f96a5}@media(max-width:620px){.card{padding:28px}.grid{grid-template-columns:1fr}.tile{padding:14px}}</style>
</head>
<body><div class="orb a"></div><div class="orb b"></div><main class="card"><div class="brand"><div class="mark">KX</div><div><strong>NEW YONKERS</strong><p style="font-size:12px">VISION MEDIA SERVICE</p></div></div><h1>Spatial media, securely hosted.</h1><p>This service powers KINGX Vision Pro camera uploads and persistent media for YBN New Yonkers. Uploads require short-lived server-authorized sessions and are stored in Cloudflare R2.</p><div class="status"><span class="dot"></span>All systems operational</div><div class="grid"><div class="tile"><strong>Uploads</strong><span>One-time authorized sessions</span></div><div class="tile"><strong>Storage</strong><span>Cloudflare R2</span></div><div class="tile"><strong>Delivery</strong><span>vision.newyonkers.org</span></div></div></main></body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method === "GET" && path === "/") return text(statusPage, 200, "text/html; charset=utf-8");
    if (request.method === "GET" && path === "/api/health") return json({ ok: true, service: "new-yonkers-vision-media", time: new Date().toISOString() });
    if (request.method === "POST" && path === "/api/upload-session") return createUploadSession(request, env);

    const upload = path.match(/^\/upload\/([a-f0-9]{64})$/);
    if (request.method === "POST" && upload) return consumeUpload(request, env, upload[1]);

    const media = path.match(/^\/media\/([a-f0-9]{32})\.jpg$/);
    if (request.method === "GET" && media) return serveMedia(env, media[1]);
    if (request.method === "DELETE" && media) return deleteMedia(request, env, media[1]);

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
