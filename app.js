// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, PORT = 3000 } = process.env;
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error("❌ Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in .env");
  process.exit(1);
}

const app = express();
app.use(cors());

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

    const text = await response.text();
    if (!response.ok) {
      console.error("Spotify token error:", response.status, text);
      return res.status(response.status).json({ error: "spotify_token_error", details: text });
    }

    const data = JSON.parse(text);
    if (!data.access_token) {
      console.error("Spotify token missing in response:", data);
      return res.status(500).json({ error: "no_access_token", details: data });
    }

    res.json({ token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    console.error("Unexpected error getting token:", err);
    res.status(500).json({ error: "server_error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
