import { Buffer } from 'buffer';
import { getFreshAccessToken } from '../lib/gmail-token.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const refreshToken = req.cookies.gmail_refresh;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  let token;
  try {
    token = await getFreshAccessToken(refreshToken);
  } catch (err) {
    return res.status(401).json({
      error: err.code === "REFRESH_EXPIRED" ? "Sessione scaduta, riconnetti Gmail" : "Errore nel rinnovo del token Gmail"
    });
  }

  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    // Codifica l'oggetto per gestire correttamente lettere accentate e caratteri speciali
    const encodedSubject = '=?UTF-8?B?' + Buffer.from(subject, 'utf-8').toString('base64') + '?=';

    // Crea il messaggio email
    const message = [
      `To: ${to}`,
      `Subject: ${encodedSubject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf-8').toString('base64')
    ].join('\r\n');

    // Codifica in base64
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    // Invia via Gmail API
    const sendResponse = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          raw: encodedMessage
        })
      }
    );

    if (!sendResponse.ok) {
      const detail = await sendResponse.text();
      throw new Error(`Gmail send error (${sendResponse.status}): ${detail.slice(0, 200)}`);
    }

    const result = await sendResponse.json();

    // Verifica reale: chiediamo a Gmail conferma che il messaggio esista davvero
    let confirmed = false;
    try {
      const checkResp = await fetch(
        `https://www.googleapis.com/gmail/v1/users/me/messages/${result.id}?format=minimal`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (checkResp.ok) {
        const checkData = await checkResp.json();
        confirmed = (checkData.labelIds || []).includes('SENT');
      }
    } catch (e) {
      // Se la verifica fallisce non blocchiamo comunque la risposta positiva
    }

    return res.status(200).json({
      success: true,
      messageId: result.id,
      threadId: result.threadId,
      confirmed
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
