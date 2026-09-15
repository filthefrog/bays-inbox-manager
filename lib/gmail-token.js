// Rinnova automaticamente il token di accesso Gmail usando il refresh token,
// così non serve più premere "Riconnetti Gmail" ogni ora.
export async function getFreshAccessToken(refreshToken) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });

  const data = await response.json();

  if (!data.access_token) {
    // invalid_grant = il refresh token stesso non è più valido (succede dopo
    // circa 7 giorni finché l'app Google è in modalità "Testing"): a quel
    // punto serve per forza un nuovo login manuale.
    const err = new Error(data.error_description || data.error || "Impossibile rinnovare il token Gmail");
    err.code = data.error === "invalid_grant" ? "REFRESH_EXPIRED" : "REFRESH_FAILED";
    throw err;
  }

  return data.access_token;
}
