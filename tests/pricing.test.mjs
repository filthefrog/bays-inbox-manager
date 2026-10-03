// Listino e PDF: le cifre che finiscono davanti agli ospiti.
// Si lanciano con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeQuote, pricingKnowledge } from '../lib/pricing.js';
import { buildQuotePdf } from '../lib/quote-pdf.js';

test('4 ospiti, 7 notti a luglio: seconda camera e sconto 15%', () => {
  const q = computeQuote({ checkIn: '2026-07-12', checkOut: '2026-07-19', guests: 4 });
  assert.equal(q.rooms, 2);
  assert.equal(q.total, 1096);
  assert.equal(q.depositAmount, 329);
});

test('stagione notte per notte: 28 maggio → 5 giugno', () => {
  const q = computeQuote({ checkIn: '2026-05-28', checkOut: '2026-06-05', guests: 2 });
  assert.deepEqual(q.groups.map(g => [g.season, g.nights]), [['Bassa stagione', 4], ['Alta stagione', 4]]);
  assert.equal(q.total, 782);
});

test('tariffa forzata e nessuno sconto', () => {
  const q = computeQuote({ checkIn: '2026-11-03', checkOut: '2026-11-05', guests: 1, rateOverride: 70, discountPercent: 0 });
  assert.equal(q.total, 140);
});

test('4 ospiti con una sola camera: rifiutato', () => {
  assert.throws(() => computeQuote({ checkIn: '2026-11-03', checkOut: '2026-11-05', guests: 4, rooms: 1 }));
});

test('date invertite: rifiutate', () => {
  assert.throws(() => computeQuote({ checkIn: '2026-11-05', checkOut: '2026-11-03' }));
});

test("il testo per l'IA contiene le stesse cifre del listino", () => {
  const t = pricingKnowledge();
  assert.match(t, /150€\/notte/);
  assert.match(t, /\+30€\/notte/);
  assert.match(t, /25€ una tantum/);
});

test('il PDF si genera ed è una sola pagina', async () => {
  const quote = computeQuote({ checkIn: '2026-05-28', checkOut: '2026-06-06', guests: 4, withSecurityDeposit: true });
  const buf = await buildQuotePdf({ guestName: 'Famiglia Bianchi', checkIn: '28 maggio 2026', checkOut: '06 giugno 2026', quote, issuedDate: '03 ottobre 2026' });
  assert.ok(buf.length > 10000);
  assert.equal(buf.toString('latin1').match(/\/Type \/Page\b/g).length, 1);
});
