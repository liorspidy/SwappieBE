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

// ✅ New endpoint to resolve short Spotify links
app.get("/api/spotify/resolve", async (req, res) => {
  const shortUrl = req.query.url;
  if (!shortUrl) return res.status(400).json({ error: "Missing URL" });

  try {
    const response = await fetch(shortUrl, { redirect: "follow" });
    res.json({ resolvedUrl: response.url });
  } catch (err) {
    console.error("Failed to resolve short link:", err);
    res.status(500).json({ error: "resolve_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
