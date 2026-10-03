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

test("all'arrivo: una sola risposta (cortese), Sonnet 5.5 a sforzo basso", async () => {
  calls.length = 0;
  script = (u) => u.includes('anthropic') ? claudeReply('{"category":"Prenotazione","tone":"Cortese","discrepancy":null,"response":"Gentile Maria, ..."}') : null;
  const out = await analyzeAndRespond({ from: 'Maria <m@x.it>', subject: 'Luglio', body: 'Libero a luglio?' }, 'k');
  assert.equal(out.responses.length, 1);
  assert.equal(out.responses[0].variant, 'cortese');
  const call = calls.find(c => c.url.includes('anthropic'));
  const body = JSON.parse(call.opt.body);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.fallbacks, 'default');
  assert.equal(call.opt.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.doesNotMatch(body.messages[0].content, /response_fermo|response_deciso/);
  assert.match(body.messages[0].content, /SEMPRE del Lei/);
});

test('rifiuto del modello: errore chiaro, nessuna risposta inventata', async () => {
  script = (u) => u.includes('anthropic') ? { status: 200, body: { stop_reason: 'refusal', content: [] } } : null;
  await assert.rejects(analyzeAndRespond({ from: 'x', subject: 'y', body: 'z' }, 'k'), /rifiutato/);
});

test('la spesa viene contata e sommata per mese', async () => {
  const { callClaude, flushUsage } = await import('../lib/claude.js');
  script = () => ({ status: 201, body: '' });
  await flushUsage(); // azzera quanto contato dai test precedenti
  let saved = null;
  script = (u, o) => {
    if (u.includes('anthropic')) return { status: 200, body: { stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 500 }, content: [{ type: 'text', text: 'ok' }] } };
    if (u.includes('app_state?id=eq.ai_usage')) return { status: 200, body: saved ? [{ value: saved }] : [] };
    if (u.includes('app_state?on_conflict')) { saved = JSON.parse(o.body).value; return { status: 201, body: '' }; }
    return null;
  };
  await callClaude('k', 'ciao', 100);
  await callClaude('k', 'ciao', 100);
  await flushUsage();
  const m = Object.values(JSON.parse(saved).months)[0];
  assert.equal(m.calls, 2);
  assert.equal(m.input, 2000);
  assert.equal(m.output, 1000);
  assert.ok(Math.abs(m.usd - 0.014) < 1e-9); // 2000 × $2/M + 1000 × $10/M
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

test('controllo automatico: notifica per ogni email nuova, con il numero sull\'icona', async () => {
  process.env.CRON_SECRET = 's';
  delete process.env.VAPID_PRIVATE_KEY; // nessun invio vero
  const cu = (await import('../api/check-urgent.js')).default;
  script = (u) => {
    if (u.includes('gmail_refresh_token')) return { status: 200, body: [{ value: 'R' }] };
    if (u.includes('oauth2')) return { status: 200, body: { access_token: 't' } };
    if (u.includes('/messages?q=')) return { status: 200, body: { messages: [{ id: 'a1' }, { id: 'b2' }] } };
    if (u.includes('/messages/a1')) return { status: 200, body: { payload: { headers: [{ name: 'From', value: 'Luca <l@x.it>' }, { name: 'Subject', value: 'Garage' }], mimeType: 'text/plain', body: { data: Buffer.from('Il garage è incluso?').toString('base64') } } } };
    if (u.includes('/messages/b2')) return { status: 200, body: { payload: { headers: [{ name: 'From', value: 'Ada <a@x.it>' }, { name: 'Subject', value: 'Grazie' }], mimeType: 'text/plain', body: { data: Buffer.from('Grazie!').toString('base64') } } } };
    if (u.includes('analyzed_emails?id=in.')) return { status: 200, body: [{ id: 'b2', resolved: false }] };
    if (u.includes('anthropic')) return claudeReply('{"category":"Richiesta informazioni","tone":"Cortese","discrepancy":null,"response":"Gentile Luca, sì."}');
    return null;
  };
  const res = mkres();
  await cu({ headers: {}, query: { secret: 's' } }, res);
  assert.equal(res.body.newlyAnalyzed, 1);
  // una email nuova non urgente notificata; sull'icona 2 (quella nuova + quella non ancora gestita)
  assert.deepEqual(res.body.notified, { count: 1, urgent: 0, badge: 2 });
  // la ricerca esclude promozioni e social: niente analisi (né notifiche) per le newsletter
  assert.ok(calls.some(c => c.url.includes(encodeURIComponent('-category:promotions'))));
});
