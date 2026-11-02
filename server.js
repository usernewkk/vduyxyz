// Hệ thống key qua vuotlink.xyz — Node.js 18+, không cần cài thư viện.
// Chạy: VUOTLINK_API_KEY=xxxx BASE_URL=https://ten-mien-cua-ban.com node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const API_KEY = process.env.VUOTLINK_API_KEY || "";
const API_URL = process.env.VUOTLINK_API_URL || "https://vuotlink.xyz/api";
const MIN_SECONDS = Number(process.env.MIN_SECONDS || 15);   // thời gian tối thiểu giữa lúc bấm Get key và lúc quay lại
const SESSION_TTL = 30 * 60 * 1000;                           // 30 phút để hoàn thành vượt link
const KEY_TTL = 24 * 60 * 60 * 1000;                          // key sống 24 giờ

const sessions = new Map();  // sid -> {nonce, created, verified, key}
const byNonce = new Map();   // nonce -> sid
const keys = new Map();      // key -> expiresAt
const hits = new Map();      // ip -> [timestamps]

const rand = (n) => crypto.randomBytes(n).toString("hex");
const json = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
};
const cookies = (req) =>
  Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]));
const setSid = (res, sid) =>
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${KEY_TTL / 1000}`);

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.created > KEY_TTL) { sessions.delete(sid); byNonce.delete(s.nonce); }
  }
  for (const [k, exp] of keys) if (exp < now) keys.delete(k);
}, 60000).unref();

async function shorten(destination) {
  const u = new URL(API_URL);
  u.searchParams.set("api", API_KEY);
  u.searchParams.set("url", destination);
  const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  const text = (await r.text()).trim();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (data && data.status === "success" && data.shortenedUrl) return data.shortenedUrl;
  if (/^https?:\/\/\S+$/.test(text)) return text;               // phòng khi API trả thẳng link
  if (data && data.message) throw new Error(data.message);
  throw new Error(`vuotlink trả về HTTP ${r.status}, không phải JSON: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const ip = req.socket.remoteAddress;

  // 1) Bấm "Get key": tạo phiên, rút gọn link quay về, trả link rút gọn
  if (req.method === "POST" && url.pathname === "/api/start") {
    if (rateLimited(ip)) return json(res, 429, { error: "Bạn bấm quá nhanh, thử lại sau một phút." });
    if (!API_KEY) return json(res, 500, { error: "Server chưa cấu hình VUOTLINK_API_KEY." });
    const sid = rand(16), nonce = rand(16);
    sessions.set(sid, { nonce, created: Date.now(), verified: false, key: null });
    byNonce.set(nonce, sid);
    try {
      const shortUrl = await shorten(`${BASE_URL}/return?r=${nonce}`);
      setSid(res, sid);
      return json(res, 200, { shortUrl });
    } catch (e) {
      sessions.delete(sid); byNonce.delete(nonce);
      return json(res, 502, { error: "Không tạo được link vượt: " + e.message });
    }
  }

  // 2) Người dùng vượt link xong và quay về đây
  if (url.pathname === "/return") {
    const sid = byNonce.get(url.searchParams.get("r") || "");
    const s = sid && sessions.get(sid);
    const age = s ? Date.now() - s.created : 0;
    if (!s || age > SESSION_TTL) { res.writeHead(302, { Location: "/?e=expired" }); return res.end(); }
    if (age < MIN_SECONDS * 1000) { res.writeHead(302, { Location: "/?e=fast" }); return res.end(); }
    if (!s.verified) {
      s.verified = true;
      s.key = "KEY-" + rand(8).toUpperCase();
      keys.set(s.key, Date.now() + KEY_TTL);
    }
    byNonce.delete(s.nonce);
    setSid(res, sid);
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  // 3) Trang chủ hỏi xem đã có key chưa
  if (url.pathname === "/api/key") {
    const s = sessions.get(cookies(req).sid);
    if (s && s.verified) return json(res, 200, { key: s.key, expires: keys.get(s.key) });
    return json(res, 200, { key: null });
  }

  // 4) Dùng cho app của bạn để kiểm tra key: /api/check?key=KEY-XXXX
  if (url.pathname === "/api/check") {
    const exp = keys.get(url.searchParams.get("key") || "");
    return json(res, 200, { valid: !!exp && exp > Date.now() });
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log(`Chạy tại ${BASE_URL}`));
