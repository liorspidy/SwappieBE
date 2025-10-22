import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, PORT = 3000 } = process.env;

const app = express();
app.use(cors());

// ✅ Spotify token endpoint
app.get("/api/spotify/token", async (_req, res) => {
  try {
    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams({ grant_type: "client_credentials" });

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      console.error("Spotify token error:", data);
      return res.status(response.status || 500).json({ error: "spotify_token_error", details: data });
    }

    res.json({ token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    console.error("Unexpected error getting token:", err);
    res.status(500).json({ error: "server_error" });
  }
});

// New endpoint to resolve short Spotify links
app.get("/api/spotify/resolve", async (req, res) => {
  let currentUrl = req.query.url;
  if (!currentUrl) return res.status(400).json({ error: "Missing URL" });

  try {
    // 1) Normalize Branch/Spotify deep-links
    //    a) If it's an app.link, force web fallback and add a desktop UA
    const isAppLink = /:\/\/(.*\.)?spotify\.app\.link/i.test(currentUrl);
    if (isAppLink) {
      const hasQuery = currentUrl.includes("?");
      // Force Branch to use the web redirect instead of app-deep-link
      currentUrl = currentUrl + (hasQuery ? "&" : "?") + "$web_only=true";
    }

    // 2) Try to follow 30x redirects manually, with a desktop UA
    const UA =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    let redirects = 0;
    const MAX = 10;

    while (redirects < MAX) {
      const r = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      });

      const loc = r.headers.get("location");
      if (loc && r.status >= 300 && r.status < 400) {
        currentUrl = loc;
        redirects++;
        continue;
      }

      // If we got an HTML page (Branch), try to extract a meta/anchor to open.spotify.com
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await r.text();

        // Try <meta http-equiv="refresh" content="0; url=...">
        const metaMatch = html.match(/http-equiv=["']refresh["'][^>]*content=["'][^"]*url=([^"']+)/i);
        if (metaMatch?.[1]) {
          currentUrl = metaMatch[1];
          redirects++;
          continue;
        }

        // Try a direct anchor to open.spotify.com
        const aMatch = html.match(/https?:\/\/open\.spotify\.com\/[^\s"'<>]+/i);
        if (aMatch?.[0]) {
          currentUrl = aMatch[0];
        }
      }
      break;
    }

    return res.json({ resolvedUrl: currentUrl });
  } catch (err) {
    console.error("Failed to resolve short link:", err);
    return res.status(500).json({ error: "resolve_error" });
  }
});


app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
