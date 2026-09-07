import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, PORT = 3000 } = process.env;

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for req.ip to reflect the real client

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());
app.use(cors({ origin: allowedOrigins }));

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Fetch timeout")), timeoutMs)
    ),
  ]);
}

// ponytail: in-memory per-IP limiter, fine for Render's single instance.
// Swap for a shared store (e.g. Redis) if this ever runs on multiple instances.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) if (entry.resetAt < now) hits.delete(ip);
}, 5 * 60_000).unref();

function rateLimit(req, res, next) {
  const now = Date.now();
  const entry = hits.get(req.ip);
  if (!entry || entry.resetAt < now) {
    hits.set(req.ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "rate_limited" });
  }
  entry.count++;
  next();
}
app.use("/api", rateLimit);

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// --- Spotify token: held server-side only, never returned to a client ---
let cachedToken = null; // { token, expiresAt }

async function getSpotifyToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) {
    return cachedToken.token;
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });

  const response = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    console.error("Spotify token error:", data);
    throw new Error("spotify_token_error");
  }

  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

async function spotifyApiFetch(path, { retry = true } = {}) {
  const token = await getSpotifyToken();
  const res = await fetchWithTimeout(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401 && retry) {
    cachedToken = null;
    return spotifyApiFetch(path, { retry: false });
  }
  return res;
}

app.get("/api/spotify/track/:id", async (req, res) => {
  try {
    const r = await spotifyApiFetch(`/tracks/${encodeURIComponent(req.params.id)}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "spotify_error" });
    res.json(data);
  } catch (err) {
    console.error("Spotify track error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/spotify/album/:id", async (req, res) => {
  try {
    const r = await spotifyApiFetch(`/albums/${encodeURIComponent(req.params.id)}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "spotify_error" });
    res.json(data);
  } catch (err) {
    console.error("Spotify album error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/spotify/search", async (req, res) => {
  const { q, type } = req.query;
  if (!q || typeof q !== "string" || !q.trim()) {
    return res.status(400).json({ error: "missing_query" });
  }
  if (!["track", "album"].includes(type)) {
    return res.status(400).json({ error: "invalid_type" });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 25);

  try {
    const params = new URLSearchParams({ q, type, limit: String(limit) });
    const r = await spotifyApiFetch(`/search?${params}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: "spotify_error" });
    res.json(data);
  } catch (err) {
    console.error("Spotify search error:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// --- Apple / iTunes Search API (free, public, no auth) ---
app.get("/api/apple/search", async (req, res) => {
  const { term } = req.query;
  if (!term || typeof term !== "string" || !term.trim()) {
    return res.status(400).json({ error: "missing_term" });
  }
  const entity = ["song", "album"].includes(req.query.entity) ? req.query.entity : "song";
  const limit = Math.min(Math.max(Number(req.query.limit) || 5, 1), 25);

  try {
    const params = new URLSearchParams({ term, entity, limit: String(limit), explicit: "Yes" });
    const response = await fetchWithTimeout(`https://itunes.apple.com/search?${params}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Apple proxy error:", err);
    res.status(500).json({ error: "apple_proxy_failed" });
  }
});

// --- Resolve spotify.link / spotify.app.link short links to open.spotify.com ---
// Only follows real HTTP redirects on an allowlisted Spotify host chain — no HTML
// scraping, no UA spoofing, per Spotify's Developer Policy ban on scraping/indexing
// Spotify Content. If a link can't be resolved this way, the caller is told to paste
// the full open.spotify.com link instead.
const SPOTIFY_LINK_HOSTS = [
  /^open\.spotify\.com$/i,
  /(^|\.)spotify\.link$/i,
  /(^|\.)spotify\.app\.link$/i,
];

function isAllowedSpotifyUrl(urlString) {
  try {
    const { protocol, hostname } = new URL(urlString);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return SPOTIFY_LINK_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

app.get("/api/spotify/resolve", async (req, res) => {
  let currentUrl = req.query.url;
  if (!currentUrl || typeof currentUrl !== "string" || !isAllowedSpotifyUrl(currentUrl)) {
    return res.status(400).json({ error: "invalid_url" });
  }

  if (/(^|\.)spotify\.app\.link$/i.test(new URL(currentUrl).hostname)) {
    const hasQuery = currentUrl.includes("?");
    currentUrl = currentUrl + (hasQuery ? "&" : "?") + "$web_only=true";
  }

  const UA = "SwappieLinkResolver/1.0";

  try {
    let redirects = 0;
    const MAX = 10;

    while (redirects < MAX) {
      const r = await fetchWithTimeout(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      });

      const loc = r.headers.get("location");
      if (!loc || r.status < 300 || r.status >= 400) break;

      const nextUrl = new URL(loc, currentUrl).toString();
      if (!isAllowedSpotifyUrl(nextUrl)) break; // never follow a redirect off Spotify's own hosts

      currentUrl = nextUrl;
      redirects++;
    }

    if (/^open\.spotify\.com$/i.test(new URL(currentUrl).hostname)) {
      return res.json({ resolvedUrl: currentUrl });
    }
    return res.status(422).json({ error: "unresolvable_link" });
  } catch (err) {
    console.error("Failed to resolve short link:", err);
    return res.status(500).json({ error: "resolve_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
