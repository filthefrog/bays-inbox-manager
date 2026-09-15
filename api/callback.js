export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.REDIRECT_URI || "https://bays-inbox-manager.vercel.app/api/callback";

  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(500).json({ error: "Missing env variables" });
  }

  try {
    // Scambia il code con un access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code"
      })
    });

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || "Failed to get token");
    }

    // Imposta entrambi i cookie in un'unica chiamata (altrimenti si sovrascrivono)
    const cookies = [
      `gmail_token=${tokenData.access_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`
    ];
    if (tokenData.refresh_token) {
      cookies.push(
        `gmail_refresh=${tokenData.refresh_token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
      );
    }
    res.setHeader("Set-Cookie", cookies);

    // Reindirizza alla dashboard, includendo temporaneamente lo scope ottenuto per debug
    const debugScope = encodeURIComponent(tokenData.scope || 'nessuno scope restituito');
    return res.redirect(`/?debug_scope=${debugScope}`);
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
