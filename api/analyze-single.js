import { analyzeAndRespond } from '../lib/analyze-email.js';
import { claudeKey } from '../lib/auth.js';
import { flushUsage } from '../lib/claude.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = await claudeKey(req, res);
  if (!apiKey) return;

  const { from, subject, body } = req.body;
  if (!from || !subject || body === undefined) {
    return res.status(400).json({ error: 'Missing email fields' });
  }

  try {
    const result = await analyzeAndRespond({ from, subject, body }, apiKey);
    await flushUsage();
    return res.status(200).json(result);
  } catch (error) {
    await flushUsage();
    return res.status(500).json({ error: error.message || 'Analisi fallita' });
  }
}
