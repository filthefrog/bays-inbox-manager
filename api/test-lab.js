import { Buffer } from 'buffer';
import { randomUUID, randomBytes } from 'crypto';
import { getFreshAccessToken } from '../lib/gmail-token.js';

// LABORATORIO DI TEST — da eliminare (o lasciare inutilizzato) dopo il collaudo.
//
// Inserisce nella TUA inbox email finte, come se le avessero scritte degli
// ospiti veri. Ogni "ospite" ha un indirizzo del tipo
//     tuamail+acmetest.nome@gmail.com
// che Gmail recapita sempre a te: quando l'app risponde o manda un preventivo
// a uno di questi indirizzi, la mail torna nella TUA inbox e non esce mai
// verso persone reali. Tutto ciò che è di test è riconoscibile da "+acmetest"
// e dall'etichetta Gmail "ACME-TEST", quindi si può cancellare in un colpo solo.
//
// Azioni:  GET  ?action=status
//          POST ?action=seed-emails   { batch: 'A' | 'B' | 'all' | '<id>' }
//          POST ?action=seed-bookings
//          POST ?action=cleanup

const TAG = 'acmetest';
const LABEL_NAME = 'ACME-TEST';
const GMAIL = 'https://www.googleapis.com/gmail/v1/users/me';

// ---------- utilità date (fuso italiano) ----------
const romeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const itDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const nightsBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

function plus(own, name) {
  const [local, domain] = own.split('@');
  return `${local}+${TAG}.${name}@${domain}`;
}

// ---------- scenari: email ----------
function emailScenarios(t) {
  const f = (n) => itDate(addDays(t, n));
  return [
    // ===== Gruppo A: flusso prenotazione =====
    {
      id: 'preventivo', batch: 'A', tag: 'marco', name: 'Marco Bianchi', title: '1 · Richiesta di preventivo',
      subject: `Richiesta disponibilità dal ${f(40)} al ${f(45)}`,
      text: `Buongiorno,\n\nvorremmo prenotare una camera per due persone dal ${f(40)} al ${f(45)} (5 notti). Siamo due adulti e arriviamo in auto: il parcheggio è compreso?\n\nPotete inviarmi un preventivo?\n\nGrazie e cordiali saluti\nMarco Bianchi`,
      checks: [
        'Finisce in «Richieste prenotazioni»',
        'Formula preventivo: date lette dalla mail, tariffa e sconto suggeriti; poi «Genera e invia PDF»',
        'La mail col PDF ti arriva in inbox (indirizzo +acmetest), non a una persona vera'
      ]
    },
    {
      id: 'conferma', batch: 'A', tag: 'marco', name: 'Marco Bianchi', title: '2 · Conferma del preventivo',
      subject: 'R: Preventivo soggiorno Domus 106',
      text: `Buonasera,\n\nabbiamo visto il preventivo e va benissimo, confermiamo la prenotazione. Come possiamo procedere con il pagamento?\n\nGrazie\nMarco Bianchi`,
      checks: [
        'Aprila DOPO aver inviato il preventivo della mail 1',
        'Sezione Prenotazione già precompilata (date, tariffa, sconto, ospiti) con banner blu',
        'Conferma: popup col codice, evento nel Calendario con lo stato di pagamento, la mail sparisce da «Richieste prenotazioni»'
      ]
    },
    {
      id: 'incoerente', batch: 'A', tag: 'roberto', name: 'Roberto Neri', title: '3 · Date incoerenti e preventivo mai inviato',
      subject: 'Conferma preventivo',
      text: `Buongiorno,\n\nconfermo il preventivo che mi avete inviato la settimana scorsa: arrivo il ${f(70)} e riparto il ${f(64)}. Saremo in tre.\n\nDitemi come procedere col pagamento.\n\nRoberto Neri`,
      checks: [
        'Banner arancione «Possibile incongruenza» (date invertite e nessun preventivo ricevuto)',
        'Nessuna precompilazione: a questo indirizzo non hai mai mandato un preventivo',
        'Con le date invertite compare l\'errore rosso sul check-out'
      ]
    },
    {
      id: 'ritorno', batch: 'A', tag: 'ritorno', name: 'Elena Greco', title: '4 · Ospite che ritorna (con storico)',
      subject: 'Ci siamo già stati: c\'è disponibilità?',
      text: `Buongiorno,\n\nsiamo stati da voi un paio di mesi fa e ci siamo trovate benissimo. Vorremmo tornare dal ${f(80)} al ${f(83)}: c'è posto?\n\nElena Greco`,
      checks: [
        'Prima crea le prenotazioni di test (sezione 2)',
        'Aprendo la mail compare il banner arancione con la nota del soggiorno precedente («Rumorosi di notte…»)'
      ]
    },
    {
      id: 'info', batch: 'A', tag: 'laura', name: 'Laura Conti', title: '5 · Domande su parcheggio, colazione, animali',
      subject: 'Alcune domande prima di prenotare',
      text: `Salve,\n\nprima di prenotare vorrei sapere: il parcheggio è incluso? C'è la colazione? Quanto dista la spiaggia? E accettate animali domestici?\n\nGrazie mille\nLaura Conti`,
      checks: [
        'Categoria «Richiesta informazioni»',
        'Risposte coerenti coi dati reali: garage incluso, colazione NON inclusa, spiaggia a circa 1,6 km',
        'Sugli animali non deve inventare una regola che non esiste'
      ]
    },
    {
      id: 'cancellazione', batch: 'A', tag: 'sara', name: 'Sara Moretti', title: '6 · Cancellazione',
      subject: 'Devo cancellare la prenotazione',
      text: `Buongiorno,\n\npurtroppo per un imprevisto di lavoro devo cancellare il soggiorno dal ${f(10)} al ${f(13)}. Come funziona per il rimborso?\n\nMi dispiace molto.\nSara Moretti`,
      checks: [
        'Categoria «Cancellazione»',
        'Le risposte citano la regola giusta (all\'inserimento: arrivo tra 10 giorni → rimborso 50%)'
      ]
    },

    // ===== Gruppo B: casi difficili =====
    {
      id: 'lamentela', batch: 'B', tag: 'giulia', name: 'Giulia Ferrari', title: '7 · Lamentela arrabbiata',
      subject: 'Vergognoso!!',
      text: `Sono rientrata ieri sera e la camera non era stata pulita: bagno sporco e lenzuola con delle macchie. In più i vicini hanno fatto rumore fino alle 3 di notte.\n\nPretendo un rimborso, altrimenti scrivo una recensione pessima. Aspetto una risposta entro oggi.\n\nGiulia Ferrari`,
      checks: [
        'Box rosso «Lamentela», tono Arrabbiato',
        'Arriva la push «Email urgente» entro circa 5 minuti (se il controllo automatico è attivo)',
        'Risposte empatiche, senza promettere rimborsi a caso'
      ]
    },
    {
      id: 'tecnico', batch: 'B', tag: 'thomas', name: 'Thomas Weber', title: '8 · Problema tecnico urgente, in tedesco',
      subject: 'Türcode funktioniert nicht',
      text: `Guten Abend,\n\nwir stehen gerade vor der Tür und der Code funktioniert nicht. Es ist schon 23 Uhr, bitte helfen Sie uns dringend!\n\nDanke,\nThomas Weber`,
      checks: [
        'Categoria «Problema tecnico», tono Urgente, push urgente',
        'Risposte nella lingua dell\'ospite (tedesco) o comunque comprensibili'
      ]
    },
    {
      id: 'fattura', batch: 'B', tag: 'studio', name: 'Studio Rossi Srl', title: '9 · Richiesta di fattura',
      subject: 'Richiesta fattura',
      text: `Buongiorno,\n\nper il soggiorno concluso il ${f(-3)} vi chiediamo la fattura intestata a Studio Rossi Srl, P.IVA 12345678901 (dato di prova), sede in via Roma 1, Ancona.\n\nGrazie,\nAmministrazione Studio Rossi`,
      checks: [
        'Categoria «Fatturazione»',
        'La risposta non inventa importi o dati fiscali che non ha'
      ]
    },
    {
      id: 'complimento', batch: 'B', tag: 'paolo', name: 'Paolo Riva', title: '10 · Complimento',
      subject: 'Grazie di tutto',
      text: `Ciao!\n\nVolevamo ringraziarvi: soggiorno perfetto, casa pulitissima e posizione comoda. Torneremo sicuramente!\n\nPaolo e Anna`,
      checks: [
        'Categoria «Complimento», nessun allarme'
      ]
    },
    {
      id: 'ambigua', batch: 'B', tag: 'andrea', name: 'Andrea Villa', title: '11 · Mail senza contesto',
      subject: 'Re:',
      text: `Ok allora a domani, grazie!`,
      checks: [
        'Senza contesto non si può classificare: deve finire in «Da verificare»',
        'Se finisce in una categoria a caso, il prompt di lib/analyze-email.js non è ancora stato aggiornato'
      ]
    },
    {
      id: 'multi', batch: 'B', tag: 'giorgio', name: 'Giorgio Sala', title: '12 · Due richieste in una',
      subject: 'Due cose',
      text: `Buongiorno, volevo sapere se possiamo anticipare l'arrivo di qualche ora. Ah, e a proposito: la notte scorsa non ho dormito per il rumore, valutate voi se è il caso di rimborsarmi qualcosa.\n\nGiorgio Sala`,
      checks: [
        'Accettabile «Lamentela» oppure «Da verificare»; NON «Complimento» o «Fatturazione»'
      ]
    },
    {
      id: 'html', batch: 'B', tag: 'chiara', name: 'Chiara Longo', title: '13 · Mail HTML annidata (stile Booking/Airbnb)',
      subject: 'Nuova richiesta di prenotazione',
      text: `Nuova richiesta di prenotazione\nOspite: Chiara Longo\nOspiti: 2\nDal ${f(50)} al ${f(53)}\nRispondi a questa email per confermare.`,
      html: `<html><body><h2>Nuova richiesta di prenotazione</h2><p><b>Ospite:</b> Chiara Longo<br><b>Ospiti:</b> 2<br><b>Dal</b> ${f(50)} <b>al</b> ${f(53)}</p><p>Rispondi a questa email per confermare.</p></body></html>`,
      checks: [
        'Nel dettaglio, «Messaggio originale» mostra il testo (non «(No body)»)',
        'Se vedi «(No body)»: è un bug reale di lettura delle mail annidate — tipiche di Booking e Airbnb'
      ]
    }
  ];
}

// ---------- scenari: prenotazioni ----------
function bookingScenarios(t, own) {
  const d = (n) => addDays(t, n);
  const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
  const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = (inDate) => {
    let s = 'T';
    for (const x of randomBytes(3)) s += CH[x % CH.length];
    return `D106-${inDate.slice(5, 7)}${inDate.slice(8, 10)}-${s}`;
  };
  const row = (o) => {
    const nights = nightsBetween(o.in, o.out);
    const disc = o.disc || 0;
    return {
      guest_name: `TEST · ${o.name}`, guest_email: plus(own, o.tag),
      check_in: o.in, check_out: o.out,
      total: Math.round(nights * o.rate * (100 - disc)) / 100,
      code: code(o.in), status: o.status || 'confermata', guests: o.guests || 2,
      payment_status: o.pay || 'da saldare', rate_per_night: o.rate, discount_percent: disc || null,
      notes: o.notes || null, checkout_reviewed: !!o.reviewed, concluded_at: o.concludedAt || null,
      cleaner_notified: !!o.cleanerNotified, cleaner_confirmed: !!o.cleanerConfirmed,
      source_from: null, source_subject: null, source_body: null
    };
  };
  return [
    {
      id: 'b-oggi', title: 'Check-out oggi',
      checks: [
        'All\'apertura dell\'app compare «Com\'è andato il soggiorno?»',
        'Rispondendo Sì: pop-up «Prossima prenotazione» col countdown (l\'arrivo di domani → circa 25 ore)',
        'La mail «alla colf» arriva a TE, marcata [TEST]: non esce verso nessun altro',
        'Poi compare il promemoria «Pulizie da confermare»'
      ],
      rows: [row({ name: 'Check-out oggi', tag: 'oggi', in: d(-4), out: d(0), rate: 100, pay: 'saldata' })]
    },
    {
      id: 'b-domani', title: 'Arrivo domani, da saldare',
      checks: ['Promemoria «Pagamenti da sollecitare»: check-in tra 1 giorno', 'Chip rosso «Da saldare»'],
      rows: [row({ name: 'Arrivo domani', tag: 'domani', in: d(1), out: d(4), rate: 120, disc: 5, pay: 'da saldare' })]
    },
    {
      id: 'b-nove', title: 'Arrivo tra 9 giorni, con acconto, 4 ospiti',
      checks: ['Chip «Acconto» e 👤 4', 'Tariffa e sconto visibili sotto il totale'],
      rows: [row({ name: 'Arrivo tra 9 giorni', tag: 'nove', in: d(9), out: d(12), rate: 90, pay: 'acconto versato', guests: 4 })]
    },
    {
      id: 'b-duore', title: 'Chiusa da 2 ore (ancora ripristinabile)',
      checks: ['In Storico con la freccia ↩ attiva (entro 48 ore)', '↩ la riporta tra le prenotazioni in corso'],
      rows: [row({ name: 'Chiusa da 2 ore', tag: 'duore', in: d(-6), out: d(-1), rate: 100, pay: 'saldata', status: 'conclusa', reviewed: true, concludedAt: ago(2), cleanerNotified: true, cleanerConfirmed: true })]
    },
    {
      id: 'b-tregiorni', title: 'Chiusa da 3 giorni (bloccata)',
      checks: [
        'In Storico con il lucchetto 🔒, dettaglio in sola lettura',
        'Nei Promemoria: «Pulizie da confermare» col pulsante «Confermato con lei»'
      ],
      rows: [row({ name: 'Chiusa da 3 giorni', tag: 'tregiorni', in: d(-10), out: d(-3), rate: 100, pay: 'saldata', status: 'conclusa', reviewed: true, concludedAt: ago(72), cleanerNotified: true, cleanerConfirmed: false })]
    },
    {
      id: 'b-elena', title: 'Storico con problemi (Elena Greco)',
      checks: ['Nota «Rumorosi di notte e camera lasciata sporca» nel dettaglio', 'Riemerge nel banner della mail 4 del gruppo A'],
      rows: [row({ name: 'Elena Greco', tag: 'ritorno', in: d(-45), out: d(-40), rate: 95, pay: 'saldata', status: 'conclusa', reviewed: true, concludedAt: ago(40 * 24), notes: 'Rumorosi di notte e camera lasciata sporca', cleanerNotified: true, cleanerConfirmed: true })]
    },
    {
      id: 'b-stat', title: 'Due soggiorni passati per le Statistiche',
      checks: ['Statistiche: incasso, notti e occupazione del mese di quei check-in', '«Con note/problemi» conta il soggiorno con la nota'],
      rows: [
        row({ name: 'Statistiche A', tag: 'stata', in: d(-38), out: d(-33), rate: 100, pay: 'saldata', status: 'conclusa', reviewed: true, concludedAt: ago(33 * 24), cleanerNotified: true, cleanerConfirmed: true }),
        row({ name: 'Statistiche B', tag: 'statb', in: d(-30), out: d(-26), rate: 110, disc: 5, pay: 'saldata', status: 'conclusa', reviewed: true, concludedAt: ago(26 * 24), notes: 'Arrivati con due ore di ritardo', cleanerNotified: true, cleanerConfirmed: true })
      ]
    }
  ];
}

// ---------- MIME ----------
const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');
const wrap = (s) => s.match(/.{1,76}/g).join('\r\n');
const encWord = (s) => '=?UTF-8?B?' + b64(s) + '?=';

function buildRaw({ fromName, fromEmail, to, subject, text, html, date }) {
  const headers = [
    `From: "${fromName}" <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encWord(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@acmetest.local>`,
    'MIME-Version: 1.0',
    'X-ACME-Test: 1'
  ];
  let body;
  if (html) {
    // multipart/mixed → multipart/alternative → text + html: come le mail vere di Booking/Airbnb
    const outer = 'acme_outer_' + randomBytes(6).toString('hex');
    const inner = 'acme_inner_' + randomBytes(6).toString('hex');
    headers.push(`Content-Type: multipart/mixed; boundary="${outer}"`);
    body = [
      `--${outer}`,
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      '',
      `--${inner}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(b64(text)),
      '',
      `--${inner}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      wrap(b64(html)),
      '',
      `--${inner}--`,
      '',
      `--${outer}--`,
      ''
    ].join('\r\n');
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    body = wrap(b64(text));
  }
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

const toBase64Url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- Gmail / Supabase ----------
async function gmail(token, path, opts = {}) {
  const r = await fetch(`${GMAIL}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 403) { const e = new Error('Permessi Gmail insufficienti'); e.code = 'SCOPE'; throw e; }
  return r;
}

async function hasModifyScope(token) {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    const s = j.scope || '';
    return s.includes('gmail.modify') || s.includes('mail.google.com');
  } catch (e) { return false; }
}

async function getOwnEmail(token) {
  const r = await gmail(token, '/profile');
  const j = await r.json();
  if (!j.emailAddress) throw new Error('Indirizzo Gmail non leggibile');
  return j.emailAddress;
}

async function getLabelId(token, create) {
  const r = await gmail(token, '/labels');
  const j = await r.json();
  const found = (j.labels || []).find(l => l.name === LABEL_NAME);
  if (found) return found.id;
  if (!create) return null;
  const c = await gmail(token, '/labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' })
  });
  const cj = await c.json();
  if (!cj.id) throw new Error('Impossibile creare l\'etichetta ' + LABEL_NAME);
  return cj.id;
}

function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

const TEST_EMAIL_FILTER = `guest_email=like.*${encodeURIComponent('+' + TAG)}*`;

// ---------- azioni ----------
async function status(token, own) {
  const t = romeToday();
  const labelId = await getLabelId(token, false);
  let emails = 0;
  if (labelId) {
    const r = await gmail(token, `/messages?labelIds=${labelId}&maxResults=100`);
    const j = await r.json();
    emails = (j.messages || []).length;
  }
  const br = await sb(`confirmed_bookings?select=id&${TEST_EMAIL_FILTER}`);
  const bookings = br.ok ? (await br.json()).length : 0;
  return {
    ownEmail: own,
    scopeOk: await hasModifyScope(token),
    counts: { emails, bookings },
    scenarios: emailScenarios(t).map(({ id, batch, name, title, checks }) => ({ id, batch, name, title, checks })),
    bookingScenarios: bookingScenarios(t, own).map(({ id, title, checks, rows }) => ({ id, title, checks, count: rows.length }))
  };
}

async function seedEmails(token, own, batch) {
  const t = romeToday();
  let list = emailScenarios(t);
  if (batch === 'A' || batch === 'B') list = list.filter(s => s.batch === batch);
  else if (batch && batch !== 'all') list = list.filter(s => s.id === batch);
  if (!list.length) throw new Error('Nessuno scenario selezionato');

  const labelId = await getLabelId(token, true);
  const n = list.length;
  await Promise.all(list.map(async (s, i) => {
    // date scaglionate, così l'ordine in inbox segue l'ordine dei numeri
    const date = new Date(Date.now() - (n - 1 - i) * 60000 - 20000);
    const raw = buildRaw({ fromName: s.name, fromEmail: plus(own, s.tag), to: own, subject: s.subject, text: s.text, html: s.html, date });
    const r = await gmail(token, '/messages?internalDateSource=dateHeader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: toBase64Url(raw), labelIds: ['INBOX', 'UNREAD', labelId] })
    });
    if (!r.ok) throw new Error('Inserimento fallito (' + r.status + '): ' + (await r.text()).slice(0, 150));
  }));
  return { inserted: n };
}

async function seedBookings(own) {
  const t = romeToday();
  const rows = bookingScenarios(t, own).flatMap(s => s.rows);
  // idempotente: ricrea solo le righe "TEST ·", senza toccare quelle nate dal tuo collaudo (es. la prenotazione di Marco)
  await sb(`confirmed_bookings?${TEST_EMAIL_FILTER}&guest_name=like.TEST*`, { method: 'DELETE' });
  const r = await sb('confirmed_bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  if (!r.ok) throw new Error('Errore Supabase: ' + (await r.text()).slice(0, 200));
  return { inserted: rows.length };
}

async function cleanup(token, own) {
  const t = romeToday();
  const ids = new Set();

  async function collect(qs) {
    let pageToken;
    do {
      const r = await gmail(token, `/messages?${qs}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`);
      const j = await r.json();
      (j.messages || []).forEach(m => ids.add(m.id));
      pageToken = j.nextPageToken;
    } while (pageToken && ids.size < 500);
  }

  // 1) le mail inserite (etichetta) 2) le risposte/preventivi finiti sugli indirizzi di test
  const labelId = await getLabelId(token, false);
  if (labelId) await collect(`labelIds=${labelId}`);
  const tags = [...emailScenarios(t).map(s => s.tag), 'oggi', 'domani', 'nove', 'duore', 'tregiorni', 'stata', 'statb'];
  const q = [...new Set(tags)].map(tag => `to:${plus(own, tag)}`).join(' OR ');
  await collect(`q=${encodeURIComponent(q)}`);

  const all = [...ids];
  for (let i = 0; i < all.length; i += 500) {
    await gmail(token, '/messages/batchModify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: all.slice(i, i + 500), addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] })
    });
  }

  // dati collegati su Supabase
  const del = async (path) => {
    const r = await sb(path, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    return r.ok ? (await r.json()).length : 0;
  };
  const bookings = await del(`confirmed_bookings?${TEST_EMAIL_FILTER}`);
  const quotes = await del(`pending_quotes?${TEST_EMAIL_FILTER}`);
  for (let i = 0; i < all.length; i += 100) {
    await del(`analyzed_emails?id=in.(${all.slice(i, i + 100).join(',')})`);
  }
  return { trashed: all.length, bookings, quotes };
}

// ---------- handler ----------
export default async function handler(req, res) {
  const refresh = req.cookies.gmail_refresh;
  if (!refresh) return res.status(401).json({ error: 'Non autenticato: accedi con Gmail' });

  let token;
  try {
    token = await getFreshAccessToken(refresh);
  } catch (err) {
    return res.status(401).json({ error: err.code === 'REFRESH_EXPIRED' ? 'Sessione scaduta, riconnetti Gmail' : 'Errore nel rinnovo del token Gmail' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }

  const action = req.query.action;
  try {
    const own = await getOwnEmail(token);
    if (action === 'status' && req.method === 'GET') return res.status(200).json(await status(token, own));
    if (action === 'seed-emails' && req.method === 'POST') return res.status(200).json(await seedEmails(token, own, (req.body || {}).batch));
    if (action === 'seed-bookings' && req.method === 'POST') return res.status(200).json(await seedBookings(own));
    if (action === 'cleanup' && req.method === 'POST') return res.status(200).json(await cleanup(token, own));
    return res.status(400).json({ error: 'Azione non valida' });
  } catch (err) {
    if (err.code === 'SCOPE') {
      return res.status(403).json({ error: 'scope', message: 'Serve un permesso Gmail in più: Impostazioni → Riconnetti Gmail, poi riprova.' });
    }
    return res.status(500).json({ error: err.message });
  }
}
