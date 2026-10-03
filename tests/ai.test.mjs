// Consumo di token: all'arrivo di un'email si genera solo la risposta
// cortese; "Fermo" e "Deciso" solo su richiesta, e una volta sola.
// Si lanciano con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://sb.test';
process.env.SUPABASE_SERVICE_KEY = 'k';
process.env.ANTHROPIC_API_KEY = 'server-key';

const calls = [];
let script = () => null;
globalThis.fetch = async (url, opt = {}) => {
  calls.push({ url: String(url), opt });
  const o = script(String(url), opt) || { status: 200, body: [] };
  return { ok: o.status < 300, status: o.status, json: async () => o.body, text: async () => typeof o.body === 'string' ? o.body : JSON.stringify(o.body) };
};
const claudeReply = (text) => ({ status: 200, body: { content: [{ type: 'text', text }] } });
const mkres = () => { const r = { code: 0, body: null }; r.status = c => { r.code = c; return r; }; r.json = b => { r.body = b; return r; }; return r; };

const { analyzeAndRespond, messageForPrompt } = await import('../lib/analyze-email.js');
const regenerate = (await import('../api/regenerate-response.js')).default;

test("all'arrivo: una sola risposta (cortese), output limitato", async () => {
  calls.length = 0;
  script = (u) => u.includes('anthropic') ? claudeReply('{"category":"Prenotazione","tone":"Cortese","discrepancy":null,"response":"Gentile Maria, ..."}') : null;
  const out = await analyzeAndRespond({ from: 'Maria <m@x.it>', subject: 'Luglio', body: 'Libero a luglio?' }, 'k');
  assert.equal(out.responses.length, 1);
  assert.equal(out.responses[0].variant, 'cortese');
  const body = JSON.parse(calls.find(c => c.url.includes('anthropic')).opt.body);
  assert.ok(body.max_tokens <= 900);
  assert.doesNotMatch(body.messages[0].content, /response_fermo|response_deciso/);
});

test('la cronologia citata non viene inviata all\'IA', () => {
  const t = messageForPrompt('Confermo!\n\nIl giorno lun 1 ott 2026 Domus 106 <a@b.it> ha scritto:\n> preventivo lungo\n> altre righe');
  assert.equal(t, 'Confermo!');
});

test('variante su richiesta: generata una volta e salvata', async () => {
  let saved = null;
  calls.length = 0;
  script = (u, o) => {
    if (u.includes('app_state')) return { status: 200, body: [{ value: 'VERO' }] };
    if (u.includes('analyzed_emails') && (!o.method || o.method === 'GET')) return { status: 200, body: [{ responses: saved || [{ label: 'Cortese', variant: 'cortese', text: 'a' }] }] };
    if (u.includes('analyzed_emails') && o.method === 'PATCH') { saved = JSON.parse(o.body).responses; return { status: 204, body: '' }; }
    if (u.includes('anthropic')) return claudeReply('Gentile Maria, purtroppo...');
    return null;
  };
  const req = { method: 'POST', headers: {}, cookies: { gmail_refresh: 'VERO' }, body: { variant: 'fermo', emailId: 'abc123def', from: 'M <m@x.it>', subject: 's', body: 'b' } };
  let res = mkres(); await regenerate(req, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.response.variant, 'fermo');
  assert.equal(saved.length, 2);
  // seconda richiesta (es. da un altro telefono): nessuna chiamata all'IA
  const before = calls.filter(c => c.url.includes('anthropic')).length;
  res = mkres(); await regenerate(req, res);
  assert.equal(res.body.cached, true);
  assert.equal(calls.filter(c => c.url.includes('anthropic')).length, before);
});

test('variante con la chiave del server: senza login rifiutata', async () => {
  script = (u) => u.includes('app_state') ? { status: 200, body: [{ value: 'VERO' }] } : (u.includes('oauth2') ? { status: 400, body: { error: 'invalid_grant' } } : null);
  const res = mkres();
  await regenerate({ method: 'POST', headers: {}, cookies: {}, body: { variant: 'deciso', emailId: 'abc123def', body: 'b' } }, res);
  assert.equal(res.code, 401);
});
