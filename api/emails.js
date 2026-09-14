export default async function handler(req, res) {
  const token = req.cookies.gmail_token;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated. Please login first." });
  }

  try {
    // Leggi la lista delle email
    const listResponse = await fetch(
      "https://www.googleapis.com/gmail/v1/users/me/messages?q=is:inbox&maxResults=20",
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!listResponse.ok) {
      throw new Error("Failed to fetch emails from Gmail");
    }

    const listData = await listResponse.json();
    const messageIds = listData.messages || [];

    // Fetch i dettagli di ogni email
    const emails = await Promise.all(
      messageIds.slice(0, 10).map(async (msg) => {
        const detailResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          {
            headers: { Authorization: `Bearer ${token}` }
          }
        );

        const detail = await detailResponse.json();
        const headers = detail.payload.headers;

        return {
          id: msg.id,
          from: headers.find(h => h.name === "From")?.value || "Unknown",
          subject: headers.find(h => h.name === "Subject")?.value || "(No subject)",
          body: extractBody(detail.payload),
          date: headers.find(h => h.name === "Date")?.value || ""
        };
      })
    );

    return res.status(200).json({ emails });
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({ error: error.message });
  }
}

function extractBody(payload) {
  if (payload.parts) {
    // Multi-part email
    const textPart = payload.parts.find(p => p.mimeType === "text/plain");
    if (textPart && textPart.body.data) {
      return Buffer.from(textPart.body.data, "base64").toString("utf-8").slice(0, 500);
    }
  }

  if (payload.body.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8").slice(0, 500);
  }

  return "(No body)";
}
