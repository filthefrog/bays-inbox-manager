export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from, subject, body, apiKey } = req.body;

  if (!from || !subject || !body || !apiKey) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // Step 1: Categorize + Generate responses in one call
    const fullPrompt = `You are Filippo, manager of BAYS guesthouse in Civitanova Marche.

KNOWLEDGE:
- Address: Via Papa Giovanni XXIII, 106, Civitanova Marche (MC)
- Type: Guesthouse (affittacamere)
- 2 rooms, 4 beds, 75 sqm
- Price: €80-150/night depending on season
- Parking included
- WiFi fiber 100 Mbps
- No breakfast (self-catering)

TONE: Warm, responsible, professional, humane. Protect the business 100%. Acknowledge client problems but don't make impossible promises. Fast responses, concrete solutions.

INCOMING EMAIL:
From: ${from}
Subject: ${subject}
Body: ${body}

TASK:
1. Categorize into ONE: Complaint, Booking, Technical Issue, Billing, Information Request, Compliment, Cancellation
2. Identify tone: Polite, Neutral, Urgent, Angry
3. Generate 3 different email responses

RESPOND WITH ONLY THIS JSON (nothing else):
{
  "category": "category name",
  "tone": "tone name",
  "response1": "first email response here",
  "response2": "second email response here",
  "response3": "third email response here"
}`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 3000,
        messages: [{ role: "user", content: fullPrompt }]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || "API Error");
    }

    const data = await response.json();
    const responseText = data.content[0].text;

    // Parse JSON response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Invalid response format");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return res.status(200).json({
      category: parsed.category || "Information Request",
      tone: parsed.tone || "Neutral",
      responses: [
        parsed.response1 || "Unable to generate response",
        parsed.response2 || "Unable to generate response",
        parsed.response3 || "Unable to generate response"
      ]
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
