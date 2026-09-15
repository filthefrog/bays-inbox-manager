export default function handler(req, res) {
  res.setHeader('Set-Cookie', [
    'gmail_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    'gmail_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
  ]);
  res.status(200).json({ ok: true });
}
