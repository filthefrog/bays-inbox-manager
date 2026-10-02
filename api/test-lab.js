import { Buffer } from 'buffer';
import { randomUUID, randomBytes } from 'crypto';
import { getFreshAccessToken } from '../lib/gmail-token.js';
import { sendPushToAll } from '../lib/send-push.js';
import { extractBody } from '../lib/analyze-email.js';

// LABORATORIO DI TEST — da eliminare (o lasciare inutilizzato) dopo il collaudo.
//
// Inserisce nella TUA inbox email finte, come se le avessero scritte degli
// ospiti veri. Ogni "ospite" ha un indirizzo del tipo
//     marco@acmetest.example.com
// su un dominio riservato (example.com): non esiste e nessuna persona reale
// può riceverlo. Non usiamo più indirizzi con il «+» della tua Gmail perché
// Gmail li considera "da te" e la dashboard li scartava (filtro -from:me).
// Tutto ciò che l'app manda a questi indirizzi viene deviato dal client su
// tuamail+acmetest.reply@gmail.com, cioè torna nella TUA inbox.
// Tutto ciò che è di test è riconoscibile da "acmetest" e dall'etichetta
// Gmail "ACME-TEST", quindi si può cancellare in un colpo solo.
//
// Azioni:  GET  ?action=status
//          POST ?action=seed-emails   { batch: 'A' | 'B' | 'all' | '<id>' }
//          POST ?action=seed-bookings
//          POST ?action=cleanup

const TAG = 'acmetest';
const TEST_DOMAIN = 'acmetest.example.com';
export const LABEL_NAME = 'ACME-TEST';
const GMAIL = 'https://www.googleapis.com/gmail/v1/users/me';

// ---------- utilità date (fuso italiano) ----------
const romeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const itDate = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const nightsBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// indirizzo di un finto ospite: dominio riservato, non "da te" per Gmail
function guest(tag) {
  return `${tag}@${TEST_DOMAIN}`;
}

// indirizzo sulla TUA casella (con il «+»): usato solo come destinazione delle mail deviate
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
        'La mail col PDF ti arriva in inbox (deviata a te), non a una persona vera'
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
      guest_name: `TEST · ${o.name}`, guest_email: guest(o.tag),
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

const TEST_EMAIL_FILTER = `guest_email=like.*${TAG}*`;   // copre sia i nuovi indirizzi sia i vecchi con il «+»

// ---------- azioni ----------
async function status(token, own, gmailError) {
  const t = romeToday();
  const labelId = token ? await getLabelId(token, false) : null;
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
    gmailError: gmailError || null,
    testDomain: TEST_DOMAIN,
    replyAddress: own ? plus(own, 'reply') : null,
    scopeOk: token ? await hasModifyScope(token) : false,
    counts: { emails, bookings },
    scenarios: emailScenarios(t).map(({ id, batch, name, title, checks, tag }) => ({ id, batch, name, title, checks, tag, ...(EXPECT[id] || {}) })),
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
  const ids = [];
  await Promise.all(list.map(async (s, i) => {
    // date scaglionate, così l'ordine in inbox segue l'ordine dei numeri
    const date = new Date(Date.now() - (n - 1 - i) * 60000 - 20000);
    const raw = buildRaw({ fromName: s.name, fromEmail: guest(s.tag), to: own, subject: s.subject, text: s.text, html: s.html, date });
    const r = await gmail(token, '/messages?internalDateSource=dateHeader', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: toBase64Url(raw), labelIds: ['INBOX', 'UNREAD', labelId] })
    });
    if (!r.ok) throw new Error('Inserimento fallito (' + r.status + '): ' + (await r.text()).slice(0, 150));
    const j = await r.json();
    if (j.id) ids.push(j.id);
  }));

  // Verifica: Gmail ha accettato le mail, ma la dashboard le legge con una
  // ricerca (is:inbox) il cui indice si aggiorna con qualche secondo di ritardo.
  // Aspetto che le veda, così l'aggiornamento successivo non parte a vuoto.
  const top = async (q) => {
    const r = await gmail(token, `/messages?q=${encodeURIComponent(q)}&maxResults=8`);
    const j = await r.json();
    return new Set((j.messages || []).map(m => m.id));
  };
  const expected = Math.min(ids.length, 8);
  let top8 = await top('is:inbox');
  for (let tries = 0; tries < 2 && ids.filter(id => top8.has(id)).length < expected; tries++) {
    await new Promise(resolve => setTimeout(resolve, 1200));
    top8 = await top('is:inbox');
  }
  // Il controllo automatico (check-urgent) usa "-from:me": se Gmail considera "da te" gli
  // indirizzi con il +, quelle mail non genererebbero mai una push.
  const top8NoMe = await top('is:inbox -from:me');
  return {
    scenarioIds: list.map(x => x.id),
    inserted: ids.length,
    inTop8: ids.filter(id => top8.has(id)).length,
    inTop8NoMe: ids.filter(id => top8NoMe.has(id)).length
  };
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
  const gmailSkipped = !token;

  async function collect(qs) {
    let pageToken;
    do {
      const r = await gmail(token, `/messages?${qs}&maxResults=100${pageToken ? '&pageToken=' + pageToken : ''}`);
      const j = await r.json();
      (j.messages || []).forEach(m => ids.add(m.id));
      pageToken = j.nextPageToken;
    } while (pageToken && ids.size < 500);
  }

  // Gmail (solo se il token è valido): 1) le mail inserite (etichetta) 2) le risposte/preventivi deviati a te
  if (!gmailSkipped) {
    const labelId = await getLabelId(token, false);
    if (labelId) await collect(`labelIds=${labelId}`);
    const tags = [...emailScenarios(t).map(s => s.tag), 'oggi', 'domani', 'nove', 'duore', 'tregiorni', 'stata', 'statb', 'reply'];
    const q = [...new Set(tags)].map(tag => `to:${plus(own, tag)}`).join(' OR ');
    await collect(`q=${encodeURIComponent(q)}`);
  }
  // le mail del collaudo automatico: anche senza Gmail so quali analisi cancellare
  const camp = await stateGet(CAMPAIGN_KEY);
  ((camp && camp.injected) || []).forEach(x => ids.add(x.id));

  const all = [...ids];
  if (!gmailSkipped) {
    for (let i = 0; i < all.length; i += 500) {
      await gmail(token, '/messages/batchModify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: all.slice(i, i + 500), addLabelIds: ['TRASH'], removeLabelIds: ['INBOX', 'UNREAD'] })
      });
    }
  }

  // dati collegati su Supabase
  const del = async (path) => {
    const r = await sb(path, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    return r.ok ? (await r.json()).length : 0;
  };
  await sb(`app_state?id=in.(${CAMPAIGN_KEY},${SEEN_KEY})`, { method: 'DELETE' });   // il collaudo automatico si ferma e si azzera
  const bookings = await del(`confirmed_bookings?${TEST_EMAIL_FILTER}`);
  const quotes = await del(`pending_quotes?${TEST_EMAIL_FILTER}`);
  for (let i = 0; i < all.length; i += 100) {
    await del(`analyzed_emails?id=in.(${all.slice(i, i + 100).join(',')})`);
  }
  return { trashed: gmailSkipped ? 0 : all.length, bookings, quotes, gmailSkipped };
}

// ---------- registro delle sessioni di test (persistente, su Supabase) ----------
// Riusa la tabella app_state (id, value) già presente: nessuna query SQL nuova.
const SESSION_KEY = 'test_lab_session';
const HISTORY_KEY = 'test_lab_history';
const freshSession = () => ({
  startedAt: new Date().toISOString(), results: {}, seeded: {}, bookingsSeeded: false,
  findings: [], autoResults: [], autoRunAt: null
});

async function stateGet(id) {
  const r = await sb(`app_state?id=eq.${id}&select=value`);
  const rows = r.ok ? await r.json() : [];
  if (!rows[0] || !rows[0].value) return null;
  try { return JSON.parse(rows[0].value); } catch (e) { return null; }
}

async function stateSet(id, obj) {
  const r = await sb('app_state?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id, value: JSON.stringify(obj) })
  });
  if (!r.ok) throw new Error('Salvataggio del registro fallito: ' + (await r.text()).slice(0, 150));
}

// ---------- cosa ci si aspetta da ogni email di prova (controlli automatici) ----------
const EXPECT = {
  preventivo:    { subjectPrefix: 'Richiesta disponibilità', expect: { categories: ['Prenotazione'] } },
  conferma:      { subjectPrefix: 'R: Preventivo soggiorno', expect: { categories: ['Prenotazione'] } },
  incoerente:    { subjectPrefix: 'Conferma preventivo', expect: { categories: ['Prenotazione'], discrepancy: true } },
  ritorno:       { subjectPrefix: 'Ci siamo già stati', expect: { categories: ['Prenotazione', 'Richiesta informazioni'] } },
  info:          { subjectPrefix: 'Alcune domande prima di prenotare', expect: { categories: ['Richiesta informazioni'] },
                   responseChecks: [
                     { label: 'Dice che la colazione è inclusa (non lo è)', severity: 'errore', mustNotMatch: "colazione (è |e' )?(inclusa|compresa)|(inclusa|compresa) la colazione", flags: 'i' },
                     { label: 'Nessuna risposta cita la distanza dalla spiaggia (circa 1,6 km)', severity: 'avviso', mustMatchAny: '1[,.]6\\s*(km|chilometri)|1600\\s*m', flags: 'i' }
                   ] },
  cancellazione: { subjectPrefix: 'Devo cancellare', expect: { categories: ['Cancellazione'] },
                   responseChecks: [
                     { label: 'Nessuna risposta cita il rimborso del 50%', severity: 'avviso', mustMatchAny: '50\\s?%|metà|cinquanta', flags: 'i' },
                     { label: 'Promette un rimborso totale (con 10 giorni di anticipo spetta il 50%)', severity: 'errore', mustNotMatch: 'rimborso (totale|completo|integrale)|100\\s?%', flags: 'i' }
                   ] },
  lamentela:     { subjectPrefix: 'Vergognoso', expect: { categories: ['Lamentela'], tones: ['Arrabbiato', 'Urgente'] },
                   responseChecks: [
                     { label: 'Promette un rimborso totale senza verifiche', severity: 'avviso', mustNotMatch: 'rimborso (totale|completo|integrale)|100\\s?%', flags: 'i' }
                   ] },
  tecnico:       { subjectPrefix: 'Türcode', expect: { categories: ['Problema tecnico'], tones: ['Urgente', 'Arrabbiato'] },
                   responseChecks: [
                     { label: 'Nessuna risposta è in tedesco', severity: 'avviso', mustMatchAny: '\\b(Guten|Sehr geehrte|Danke|Entschuldigung|Türcode)\\b', flags: 'i' }
                   ] },
  fattura:       { subjectPrefix: 'Richiesta fattura', expect: { categories: ['Fatturazione'] } },
  complimento:   { subjectPrefix: 'Grazie di tutto', expect: { categories: ['Complimento'] } },
  ambigua:       { subjectPrefix: 'Re:', expect: { categories: ['Da verificare'] } },
  multi:         { subjectPrefix: 'Due cose', expect: { categories: ['Lamentela', 'Da verificare'] } },
  html:          { subjectPrefix: 'Nuova richiesta di prenotazione', expect: { categories: ['Prenotazione'], bodyNotEmpty: true } }
};

// ---------- diagnostica di sistema ----------
async function diag(token, gmailError) {
  const checks = [];
  const add = (key, title, ok, detail, severity) =>
    checks.push({ key, group: 'Sistema', title, ok: !!ok, detail: detail || '', severity: severity || 'errore' });
  add('gmail:session', 'Sessione Gmail valida', !!token, gmailError || 'Riconnetti Gmail da Impostazioni');

  for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ANTHROPIC_API_KEY', 'CRON_SECRET']) {
    const auto = name === 'ANTHROPIC_API_KEY' || name === 'CRON_SECRET';
    add('env:' + name, `Variabile ${name} su Vercel`, !!process.env[name],
      'Non impostata: ' + (auto ? 'il controllo automatico ogni 5 minuti non può funzionare' : 'una parte dell\'app non funzionerà'));
  }

  // Tabelle e colonne che il codice si aspetta: rivela le query SQL non ancora eseguite
  const tables = [
    ['confirmed_bookings', 'id,code,guest_name,guest_email,check_in,check_out,total,status,guests,payment_status,rate_per_night,discount_percent,notes,checkout_reviewed,concluded_at,cleaner_notified,cleaner_confirmed,source_from,source_subject,source_body'],
    ['pending_quotes', 'guest_email,guest_name,check_in,check_out,rate_per_night,discount_percent,guests,total,source_subject,created_at'],
    ['analyzed_emails', 'id,category,tone,discrepancy,responses,resolved'],
    ['app_state', 'id,value'],
    ['push_subscriptions', 'id,subscription']
  ];
  for (const [table, cols] of tables) {
    try {
      const r = await sb(`${table}?select=${cols}&limit=1`);
      add('db:' + table, `Tabella ${table} con tutte le colonne attese`, r.ok, r.ok ? '' : (await r.text()).slice(0, 220));
    } catch (e) { add('db:' + table, `Tabella ${table}`, false, e.message); }
  }

  const one = async (path) => { const r = await sb(path); return r.ok ? await r.json() : []; };
  const tk = await one('app_state?id=eq.gmail_refresh_token&select=value');
  add('cron:token', 'Token Gmail salvato per il controllo automatico', !!(tk[0] && tk[0].value),
    'Riconnetti Gmail: senza, il controllo ogni 5 minuti non legge la posta');
  const ce = await one('app_state?id=eq.cleaner_email&select=value');
  add('cfg:cleaner', 'Email della persona delle pulizie configurata', !!(ce[0] && ce[0].value),
    'Nessun avviso pulizie partirà finché non la imposti (Impostazioni)', 'avviso');
  const ps = await one('push_subscriptions?select=id&limit=1');
  add('push:subs', 'Almeno un dispositivo iscritto alle notifiche push', ps.length > 0,
    'Attiva le notifiche da Impostazioni', 'avviso');
  if (token) add('gmail:scope', 'Permesso Gmail per il laboratorio', await hasModifyScope(token),
    'Impostazioni → Riconnetti Gmail', 'avviso');

  // Le mail di prova sono visibili alla ricerca che usa la dashboard? Provo le ricerche
  // più probabili e riporto quante mail di prova trova ciascuna: dice quale filtro le scarta.
  if (token) try {
    const labelId = await getLabelId(token, false);
    const listIds = async (qs) => {
      const r = await gmail(token, `/messages?${qs}&maxResults=100`);
      const j = await r.json();
      return (j.messages || []).map(m => m.id);
    };
    const testIds = new Set(labelId ? await listIds(`labelIds=${labelId}`) : []);
    if (testIds.size === 0) {
      add('mail:present', 'Email di prova presenti in Gmail (etichetta ACME-TEST)', true, 'Nessuna al momento: inseriscile dal laboratorio');
    } else {
      const queries = ['is:inbox', 'is:inbox -from:me', 'is:inbox category:primary', 'is:inbox is:unread'];
      const lists = await Promise.all(queries.map(q => listIds('q=' + encodeURIComponent(q))));
      const count = (ids, n) => ids.slice(0, n).filter(id => testIds.has(id)).length;
      add('mail:present', 'Email di prova presenti in Gmail (etichetta ACME-TEST)', true,
        `${testIds.size} email di prova, ${count(lists[0], 100)} nella posta in arrivo`);
      queries.forEach((q, i) => {
        const in8 = count(lists[i], 8), in100 = count(lists[i], 100);
        const ok = in100 === testIds.size && (i !== 0 || in8 > 0);
        let detail = `${in100} su ${testIds.size} nelle prime 100 · ${in8} su 8 tra le più recenti sono di prova`;
        if (!ok && i === 0) detail += ' — la dashboard legge le ultime 8: se nessuna è di prova, altre mail più recenti le nascondono';
        if (!ok && i === 1) detail += ' — Gmail considera «da te» le mail con il «+»: la ricerca con -from:me le scarta';
        if (!ok && i === 2) detail += ' — le mail inserite non hanno la categoria «Principale»';
        add('mail:q:' + i, `La ricerca «${q}» trova le mail di prova`, ok, detail, i === 0 ? 'errore' : 'avviso');
      });
    }
  } catch (e) {
    add('mail:diag', 'Diagnosi delle mail di prova', false, e.message, 'avviso');
  }
  return checks;
}

// =====================================================================
// COLLAUDO AUTOMATICO DI 7 GIORNI
// Ogni ~5 minuti il controllo automatico (api/check-urgent.js, avviato da
// GitHub Actions) chiama runCampaignTick(): se il collaudo è attivo inserisce
// email di prova a intervalli casuali durante il giorno, poi controlla da solo
// se sono state analizzate e classificate come previsto e se sono comparse nella
// dashboard. Tutto finisce in un registro (app_state) da cui nasce il report.
// =====================================================================
const CAMPAIGN_KEY = 'test_campaign';
const SEEN_KEY = 'test_campaign_seen';
const CAMPAIGN_DAYS = 7;
const ACTIVE_FROM = 8.5;    // ore italiane: prima non arrivano email di prova
const ACTIVE_TO = 21.5;     // dopo neanche
const GAP_MIN = 90;         // minuti tra un'email e la successiva (~5-6 al giorno)
const GAP_MAX = 210;

// Una "storia" è una o più email dello stesso ospite. La 'conferma' arriva ore dopo il 'preventivo'.
const STORYLINES = [
  [{ id: 'preventivo' }, { id: 'conferma', afterMin: 180 }],
  [{ id: 'incoerente' }], [{ id: 'info' }], [{ id: 'cancellazione' }], [{ id: 'lamentela' }], [{ id: 'tecnico' }],
  [{ id: 'fattura' }], [{ id: 'complimento' }], [{ id: 'ambigua' }], [{ id: 'multi' }], [{ id: 'html' }]
];

const romeInfo = (d) => {
  const parts = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const hour = Number(parts.find(x => x.type === 'hour').value) % 24;
  const minute = Number(parts.find(x => x.type === 'minute').value);
  return { hour, minute, hf: hour + minute / 60, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d) };
};
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function addIssue(st, key, severity, title, detail, minIntervalMin) {
  st.issues = st.issues || {};
  const at = new Date().toISOString();
  const it = st.issues[key] || (st.issues[key] = { key, severity, title, count: 0, firstAt: at, examples: [] });
  // condizioni che restano vere per ore (es. token scaduto) contano una volta ogni tot minuti, non a ogni giro
  if (minIntervalMin && it.lastAt && (Date.now() - new Date(it.lastAt).getTime()) < minIntervalMin * 60000) return;
  it.count += 1; it.lastAt = at; it.severity = severity; it.title = title;
  if (detail && !it.examples.includes(detail)) { it.examples.push(detail); if (it.examples.length > 3) it.examples.shift(); }
}
const clearIssue = (st, key) => { if (st.issues && st.issues[key]) delete st.issues[key]; };

const newCampaign = () => {
  const now = new Date();
  return {
    active: true, paused: false, startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + CAMPAIGN_DAYS * 86400000).toISOString(),
    nextDueAt: null, cycle: 0, order: null, cursor: 0, followUps: [], injected: [], issues: {},
    ticks: { count: 0, last: null, maxGapMin: 0, byDay: {} }, diagDay: null, summaryDay: null, finishedAt: null
  };
};

async function injectScenario(st, token, own, scenarioId, tag, nowIso) {
  const sc = emailScenarios(romeToday()).find(x => x.id === scenarioId);
  if (!sc) throw new Error('Scenario sconosciuto: ' + scenarioId);
  const labelId = await getLabelId(token, true);
  const raw = buildRaw({ fromName: sc.name, fromEmail: guest(tag), to: own, subject: sc.subject, text: sc.text, html: sc.html, date: new Date(Date.now() - 10000) });
  const r = await gmail(token, '/messages?internalDateSource=dateHeader', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: toBase64Url(raw), labelIds: ['INBOX', 'UNREAD', labelId] })
  });
  if (!r.ok) throw new Error('Inserimento fallito (' + r.status + ')');
  const j = await r.json();
  st.injected = st.injected || [];
  st.injected.push({ id: j.id, scenarioId, tag, at: nowIso, evaluated: false });
  if (st.injected.length > 300) st.injected = st.injected.slice(-300);
  return j.id;
}

function pickStoryline(st) {
  if (!st.order || st.cursor >= st.order.length) {
    if (st.order) st.cycle = (st.cycle || 0) + 1;
    st.order = shuffle(STORYLINES.map((_, i) => i));
    st.cursor = 0;
  }
  return STORYLINES[st.order[st.cursor++]];
}

async function launchStoryline(st, token, own, now) {
  const line = pickStoryline(st);
  const byId = Object.fromEntries(emailScenarios(romeToday()).map(x => [x.id, x]));
  const suffix = '-c' + ((st.cycle || 0) + 1);   // indirizzo diverso a ogni giro (e diverso dalle prove manuali), così storico e preventivi non si mescolano
  for (let i = 0; i < line.length; i++) {
    const step = line[i];
    const tag = byId[step.id].tag + suffix;
    if (i === 0) await injectScenario(st, token, own, step.id, tag, now.toISOString());
    else (st.followUps = st.followUps || []).push({ scenarioId: step.id, tag, notBefore: new Date(now.getTime() + step.afterMin * 60000).toISOString() });
  }
}

const responseTexts = (responses) => {
  let r = responses;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = [r]; } }
  return (Array.isArray(r) ? r : []).map(x => (x && typeof x === 'object') ? (x.text || '') : (x || '')).filter(Boolean);
};

async function fetchBody(token, id) {
  const r = await gmail(token, `/messages/${id}?format=full`);
  const j = await r.json();
  return j.payload ? extractBody(j.payload) : '';
}

// Confronta quello che l'app ha fatto con quello che ci si aspettava, mail per mail
async function evaluatePending(st, token, now) {
  const inj = st.injected || [];
  const pending = inj.filter(x => !x.evaluated && (now - new Date(x.at)) >= 8 * 60000);
  if (pending.length) {
    const r = await sb(`analyzed_emails?id=in.(${pending.map(x => x.id).join(',')})&select=id,category,tone,discrepancy,responses,resolved`);
    const byId = Object.fromEntries((r.ok ? await r.json() : []).map(x => [x.id, x]));
    const titles = Object.fromEntries(emailScenarios(romeToday()).map(x => [x.id, x.title]));
    for (const x of pending) {
      const ageMin = Math.round((now - new Date(x.at)) / 60000);
      const row = byId[x.id];
      const title = titles[x.scenarioId] || x.scenarioId;
      if (!row) {
        if (ageMin >= 40) {
          x.evaluated = true; x.result = { ok: false, notAnalyzed: true };
          addIssue(st, 'na:analysis', 'errore', 'Email di prova mai analizzate dal sistema', `${title}: dopo ${ageMin} minuti nessuna analisi`);
        }
        continue;
      }
      x.evaluated = true; x.analysisMin = ageMin;
      const ex = (EXPECT[x.scenarioId] || {});
      const e = ex.expect || {};
      const problems = [];
      if (e.categories && !e.categories.includes(row.category)) problems.push({ key: `cls:${x.scenarioId}`, sev: 'errore', title: `${title}: categoria sbagliata`, detail: `«${row.category}» invece di ${e.categories.map(c => '«' + c + '»').join(' o ')}` });
      if (e.tones && !e.tones.includes(row.tone)) problems.push({ key: `tone:${x.scenarioId}`, sev: 'errore', title: `${title}: tono sbagliato`, detail: `«${row.tone}» invece di ${e.tones.map(c => '«' + c + '»').join(' o ')}` });
      if (e.discrepancy && !row.discrepancy) problems.push({ key: `disc:${x.scenarioId}`, sev: 'errore', title: `${title}: nessuna incongruenza segnalata`, detail: 'attesa una segnalazione' });
      if (e.bodyNotEmpty) {
        let body = '';
        try { body = await fetchBody(token, x.id); } catch (err) { body = ''; }
        if (!body || body === '(No body)') problems.push({ key: `body:${x.scenarioId}`, sev: 'errore', title: `${title}: testo della mail illeggibile`, detail: 'mostrato «(No body)»' });
      }
      const texts = responseTexts(row.responses);
      (ex.responseChecks || []).forEach((rc, i) => {
        if (!texts.length) return;
        let bad, why = '';
        if (rc.mustMatchAny) { const re = new RegExp(rc.mustMatchAny, rc.flags || ''); bad = !texts.some(t => re.test(t)); if (bad) why = 'assente in tutte le risposte'; }
        else { const re = new RegExp(rc.mustNotMatch, rc.flags || ''); const hit = texts.map(t => t.match(re)).find(Boolean); bad = !!hit; if (bad) why = `«${hit[0]}»`; }
        if (bad) problems.push({ key: `resp:${x.scenarioId}:${i}`, sev: rc.severity, title: `${title}: ${rc.label}`, detail: why });
      });
      x.result = { ok: problems.length === 0, category: row.category, tone: row.tone };
      problems.forEach(pr => addIssue(st, pr.key, pr.sev, pr.title, pr.detail));
    }
  }

  // Visibilità in dashboard: l'app è stata aperta DOPO l'arrivo e la mail non c'era in elenco?
  const seen = (await stateGet(SEEN_KEY)) || { ids: {}, lastLoadAt: null };
  const toCheck = inj.filter(x => !x.visChecked && (now - new Date(x.at)) >= 20 * 60000);
  if (toCheck.length && seen.lastLoadAt) {
    const r2 = await sb(`analyzed_emails?id=in.(${toCheck.map(x => x.id).join(',')})&select=id,resolved`);
    const resolved = Object.fromEntries((r2.ok ? await r2.json() : []).map(x => [x.id, x.resolved]));
    const titles = Object.fromEntries(emailScenarios(romeToday()).map(x => [x.id, x.title]));
    for (const x of toCheck) {
      const ageMin = (now - new Date(x.at)) / 60000;
      if (seen.ids[x.id]) { x.visChecked = true; x.seenInDashboard = true; }
      else if (new Date(seen.lastLoadAt) > new Date(new Date(x.at).getTime() + 3 * 60000)) {
        x.visChecked = true;
        if (!resolved[x.id]) {
          x.missed = true;
          addIssue(st, 'vis:dashboard', 'errore', 'Email di prova non comparsa nella dashboard', `${titles[x.scenarioId] || x.scenarioId}: l'app è stata aperta dopo l'arrivo ma la mail non era in elenco`);
        }
      } else if (ageMin > 48 * 60) x.visChecked = true;   // app mai aperta: non giudicabile
    }
  }
}

function summarize(st, seen) {
  const now = new Date();
  const inj = st.injected || [];
  const analyzed = inj.filter(x => x.evaluated && !(x.result && x.result.notAnalyzed));
  const correct = analyzed.filter(x => x.result && x.result.ok);
  const mins = analyzed.map(x => x.analysisMin).filter(n => typeof n === 'number');
  const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(iso));
  const days = {};
  inj.forEach(x => {
    const d = days[dayOf(x.at)] = days[dayOf(x.at)] || { date: dayOf(x.at), injected: 0, analyzed: 0, correct: 0, notAnalyzed: 0, missed: 0 };
    d.injected++;
    if (x.evaluated) { if (x.result && x.result.notAnalyzed) d.notAnalyzed++; else { d.analyzed++; if (x.result && x.result.ok) d.correct++; } }
    if (x.missed) d.missed++;
  });
  Object.entries((st.ticks && st.ticks.byDay) || {}).forEach(([date, v]) => { (days[date] = days[date] || { date, injected: 0, analyzed: 0, correct: 0, notAnalyzed: 0, missed: 0 }).maxGapMin = v.maxGapMin; });
  const per = {};
  analyzed.forEach(x => { const p = per[x.scenarioId] = per[x.scenarioId] || { id: x.scenarioId, n: 0, ok: 0 }; p.n++; if (x.result && x.result.ok) p.ok++; });
  const day = Math.min(CAMPAIGN_DAYS, Math.floor((now - new Date(st.startedAt)) / 86400000) + 1);
  return {
    active: !!st.active, paused: !!st.paused, day, totalDays: CAMPAIGN_DAYS,
    startedAt: st.startedAt, endsAt: st.endsAt, finishedAt: st.finishedAt, nextDueAt: st.nextDueAt,
    injected: inj.length, analyzed: analyzed.length, correct: correct.length,
    notAnalyzed: inj.filter(x => x.result && x.result.notAnalyzed).length,
    missed: inj.filter(x => x.missed).length, seenInDashboard: inj.filter(x => x.seenInDashboard).length,
    accuracyPct: analyzed.length ? Math.round(100 * correct.length / analyzed.length) : null,
    avgAnalysisMin: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
    ticks: { count: (st.ticks || {}).count || 0, last: (st.ticks || {}).last || null, maxGapMin: (st.ticks || {}).maxGapMin || 0 },
    byDay: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
    perScenario: Object.values(per),
    lastDashboardLoadAt: seen ? seen.lastLoadAt : null,
    issues: Object.values(st.issues || {})
  };
}

export async function runCampaignTick() {
  const st = await stateGet(CAMPAIGN_KEY);
  if (!st || !st.active) return { campaign: 'inattivo' };
  const now = new Date();
  const rp = romeInfo(now);

  // battito del controllo automatico: quanto tempo passa tra un giro e l'altro?
  st.ticks = st.ticks || { count: 0, last: null, maxGapMin: 0, byDay: {} };
  const bd = st.ticks.byDay[rp.date] = st.ticks.byDay[rp.date] || { n: 0, maxGapMin: 0 };
  if (st.ticks.last) {
    const gap = Math.round((now - new Date(st.ticks.last)) / 60000);
    if (gap > bd.maxGapMin) bd.maxGapMin = gap;
    if (gap > st.ticks.maxGapMin) st.ticks.maxGapMin = gap;
    if (gap > 30 && rp.hf >= 8 && rp.hf <= 22) addIssue(st, 'hb:gap', 'avviso', 'Il controllo automatico ogni 5 minuti ha saltato dei giri', `buco di ${gap} minuti`);
  }
  bd.n++; st.ticks.count++; st.ticks.last = now.toISOString();

  if (st.paused) { await stateSet(CAMPAIGN_KEY, st); return { campaign: 'in pausa' }; }

  if (now >= new Date(st.endsAt)) {
    st.active = false; st.finishedAt = now.toISOString();
    const sm = summarize(st, await stateGet(SEEN_KEY));
    await stateSet(CAMPAIGN_KEY, st);
    try { await sendPushToAll({ title: 'Collaudo di 7 giorni terminato', body: `${sm.injected} mail, ${sm.accuracyPct == null ? '—' : sm.accuracyPct + '%'} classificate bene. Apri il laboratorio per il report.`, url: '/' }); } catch (e) {}
    return { campaign: 'terminato' };
  }

  let token, own;
  try {
    const rt = await sb('app_state?id=eq.gmail_refresh_token&select=value');
    const rows = rt.ok ? await rt.json() : [];
    if (!rows[0] || !rows[0].value) throw new Error('nessun token Gmail salvato');
    token = await getFreshAccessToken(rows[0].value);
    own = await getOwnEmail(token);
    clearIssue(st, 'token');
  } catch (e) {
    addIssue(st, 'token', 'errore', 'Token Gmail non valido: il controllo automatico non può più leggere la posta', e.message, 60);
    await stateSet(CAMPAIGN_KEY, st);
    return { campaign: 'token non valido' };
  }

  await evaluatePending(st, token, now);

  // una volta al giorno: controlli di sistema (variabili, tabelle, token), in un giro a parte per restare sotto i 10 secondi
  if (st.diagDay !== rp.date && rp.hf >= 7) {
    st.diagDay = rp.date;
    const checks = await diag(token);
    checks.forEach(c => { if (c.ok) clearIssue(st, 'diag:' + c.key); else addIssue(st, 'diag:' + c.key, c.severity, c.title, c.detail); });
    await stateSet(CAMPAIGN_KEY, st);
    return { campaign: 'controlli di sistema eseguiti', heavy: true };
  }

  // riepilogo serale con notifica
  if (rp.hf >= ACTIVE_TO && rp.hf < 23 && st.summaryDay !== rp.date) {
    st.summaryDay = rp.date;
    const sm = summarize(st, await stateGet(SEEN_KEY));
    const today = sm.byDay.find(d => d.date === rp.date) || { injected: 0, correct: 0, analyzed: 0 };
    const open = sm.issues.filter(i => i.severity === 'errore').length;
    try { await sendPushToAll({ title: `Collaudo, giorno ${sm.day} di ${sm.totalDays}`, body: `Oggi ${today.injected} mail, ${today.correct}/${today.analyzed} classificate bene. ${open ? open + ' problemi aperti.' : 'Nessun problema aperto.'}`, url: '/' }); } catch (e) {}
  }

  // nuove email di prova, solo nella fascia diurna
  let injectedNow = 0;
  if (rp.hf >= ACTIVE_FROM && rp.hf < ACTIVE_TO) {
    const ready = (st.followUps || []).filter(f => now >= new Date(f.notBefore));
    for (const f of ready) { await injectScenario(st, token, own, f.scenarioId, f.tag, now.toISOString()); injectedNow++; }
    st.followUps = (st.followUps || []).filter(f => now < new Date(f.notBefore));
    if (!st.nextDueAt || now >= new Date(st.nextDueAt)) {
      await launchStoryline(st, token, own, now);
      injectedNow++;
      st.nextDueAt = new Date(now.getTime() + rnd(GAP_MIN, GAP_MAX) * 60000).toISOString();
    }
  }
  await stateSet(CAMPAIGN_KEY, st);
  return { campaign: 'attivo', injectedNow };
}

// ---------- handler ----------
export default async function handler(req, res) {
  const refresh = req.cookies.gmail_refresh;
  if (!refresh) return res.status(401).json({ error: 'Non autenticato: accedi con Gmail' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase non configurato' });
  }

  const action = req.query.action;
  // Il token Gmail serve solo alle azioni che parlano con Gmail. Report, registro e reset
  // devono funzionare anche quando il token è scaduto: è proprio allora che servono.
  const needsGmail = ['status', 'seed-emails', 'cleanup', 'diag', 'campaign-start'].includes(action);
  const partialOk = ['status', 'cleanup', 'diag'].includes(action);
  let token = null, own = null, gmailError = null;
  if (needsGmail) {
    try {
      token = await getFreshAccessToken(refresh);
      own = await getOwnEmail(token);
    } catch (err) {
      token = null; own = null;
      gmailError = err.code === 'REFRESH_EXPIRED' ? 'Sessione Gmail scaduta: riconnetti Gmail' : ('Gmail non raggiungibile: ' + err.message);
      if (!partialOk) return res.status(401).json({ error: gmailError });
    }
  }

  try {
    if (action === 'status' && req.method === 'GET') return res.status(200).json(await status(token, own, gmailError));
    if (action === 'seed-emails' && req.method === 'POST') return res.status(200).json(await seedEmails(token, own, (req.body || {}).batch));
    if (action === 'seed-bookings' && req.method === 'POST') return res.status(200).json(await seedBookings(own));
    if (action === 'cleanup' && req.method === 'POST') return res.status(200).json(await cleanup(token, own));
    if (action === 'campaign-get' && req.method === 'GET') {
      const st = await stateGet(CAMPAIGN_KEY);
      const seen = await stateGet(SEEN_KEY);
      return res.status(200).json({ campaign: st ? summarize(st, seen) : null });
    }
    if (action === 'campaign-start' && req.method === 'POST') {
      const st = newCampaign();
      await launchStoryline(st, token, own, new Date());        // la prima email arriva subito
      st.nextDueAt = new Date(Date.now() + rnd(GAP_MIN, GAP_MAX) * 60000).toISOString();
      await stateSet(CAMPAIGN_KEY, st);
      await stateSet(SEEN_KEY, { ids: {}, lastLoadAt: null });
      return res.status(200).json({ campaign: summarize(st, null) });
    }
    if ((action === 'campaign-toggle' || action === 'campaign-stop') && req.method === 'POST') {
      const st = await stateGet(CAMPAIGN_KEY);
      if (!st) return res.status(404).json({ error: 'Nessun collaudo in corso' });
      if (action === 'campaign-toggle') st.paused = !st.paused;
      else { st.active = false; st.finishedAt = new Date().toISOString(); }
      await stateSet(CAMPAIGN_KEY, st);
      return res.status(200).json({ campaign: summarize(st, await stateGet(SEEN_KEY)) });
    }
    if (action === 'campaign-seen' && req.method === 'POST') {
      // l'app dice quali email di prova ha appena mostrato in dashboard (anche nessuna: serve a sapere che è stata aperta)
      const ids = ((req.body || {}).ids || []).filter(x => typeof x === 'string').slice(0, 100);
      const seen = (await stateGet(SEEN_KEY)) || { ids: {}, lastLoadAt: null };
      const nowIso = new Date().toISOString();
      ids.forEach(id => { if (!seen.ids[id]) seen.ids[id] = nowIso; });
      seen.lastLoadAt = nowIso;
      const keys = Object.keys(seen.ids);
      if (keys.length > 400) keys.sort((a, b) => seen.ids[a].localeCompare(seen.ids[b])).slice(0, keys.length - 400).forEach(k => delete seen.ids[k]);
      await stateSet(SEEN_KEY, seen);
      return res.status(200).json({ ok: true });
    }
    if (action === 'diag' && req.method === 'GET') return res.status(200).json({ checks: await diag(token, gmailError) });
    if (action === 'log-get' && req.method === 'GET') {
      const saved = await stateGet(SESSION_KEY);
      const history = (await stateGet(HISTORY_KEY)) || [];
      return res.status(200).json({ session: { ...freshSession(), ...(saved || {}) }, historyCount: history.length });
    }
    if (action === 'log-save' && req.method === 'POST') {
      const session = (req.body || {}).session;
      if (!session || typeof session !== 'object') return res.status(400).json({ error: 'Sessione mancante' });
      if (JSON.stringify(session).length > 400000) return res.status(400).json({ error: 'Registro troppo grande' });
      await stateSet(SESSION_KEY, session);
      return res.status(200).json({ ok: true });
    }
    if (action === 'log-close' && req.method === 'POST') {
      const report = (req.body || {}).report || {};
      const cur = (await stateGet(SESSION_KEY)) || freshSession();
      const history = (await stateGet(HISTORY_KEY)) || [];
      history.unshift({ closedAt: new Date().toISOString(), startedAt: cur.startedAt, summary: report.summary || {}, text: String(report.text || '').slice(0, 60000) });
      await stateSet(HISTORY_KEY, history.slice(0, 10));
      const fresh = freshSession();
      await stateSet(SESSION_KEY, fresh);
      return res.status(200).json({ session: fresh });
    }
    if (action === 'history-get' && req.method === 'GET') return res.status(200).json({ history: (await stateGet(HISTORY_KEY)) || [] });
    return res.status(400).json({ error: 'Azione non valida' });
  } catch (err) {
    if (err.code === 'SCOPE') {
      return res.status(403).json({ error: 'scope', message: 'Serve un permesso Gmail in più: Impostazioni → Riconnetti Gmail, poi riprova.' });
    }
    return res.status(500).json({ error: err.message });
  }
}
