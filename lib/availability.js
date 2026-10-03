// Calendario unico di Domus 106: prenotazioni dirette salvate in ACME più le
// date occupate su Booking e Airbnb (dai loro link iCal). Serve a evitare le
// doppie prenotazioni: avvisi nel preventivo, contesto per l'IA, e il feed
// iCal che Booking e Airbnb leggono per chiudere le date prese direttamente.

const sbHeaders = () => ({ apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` });
const sbUrl = (path) => `${process.env.SUPABASE_URL}/rest/v1/${path}`;

export async function stateGet(id) {
  const r = await fetch(sbUrl(`app_state?id=eq.${encodeURIComponent(id)}&select=value`), { headers: sbHeaders() });
  const rows = r.ok ? await r.json() : [];
  return rows[0] ? rows[0].value : null;
}

export async function stateSet(id, value) {
  const r = await fetch(sbUrl('app_state?on_conflict=id'), {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ id, value })
  });
  if (!r.ok) throw new Error('Salvataggio impostazioni fallito: ' + (await r.text()).slice(0, 150));
}

// Link iCal di Booking e Airbnb, salvati dalle impostazioni dell'app
export async function getIcalSources() {
  try { return JSON.parse((await stateGet('ical_import')) || '{}'); } catch (e) { return {}; }
}

// ---------- lettura iCal ----------
const toIso = (v) => {
  const m = String(v || '').match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

export function parseIcs(text) {
  // Le righe lunghe in iCal continuano nella riga dopo, che inizia con uno spazio
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur && cur.start) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase();
      const val = line.slice(i + 1);
      if (key === 'DTSTART') cur.start = toIso(val);
      else if (key === 'DTEND') cur.end = toIso(val);
      else if (key === 'SUMMARY') cur.summary = val.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
    }
  }
  // Evento di un giorno senza DTEND: occupa quella notte
  return events.map(e => ({ ...e, end: e.end && e.end > e.start ? e.end : addDays(e.start, 1) }));
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const cache = new Map(); // url -> { at, events }
async function fetchIcal(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.events;
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'ACME-Domus106/1.0' } });
  if (!r.ok) throw new Error(`risposta ${r.status}`);
  const events = parseIcs(await r.text());
  cache.set(url, { at: Date.now(), events });
  return events;
}

// Tutte le notti occupate che toccano l'intervallo [from, to).
// Ritorna { ranges: [{start, end, source, label}], errors: [testo], checked: [fonti lette] }
export async function getOccupied({ from, to, excludeBookingId } = {}) {
  const ranges = [];
  const errors = [];
  const checked = [];
  try {
    let q = 'confirmed_bookings?select=id,guest_name,check_in,check_out,status&status=neq.cancellata';
    if (from) q += `&check_out=gt.${from}`;
    if (to) q += `&check_in=lt.${to}`;
    const r = await fetch(sbUrl(q), { headers: sbHeaders() });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    (await r.json()).forEach(b => {
      if (excludeBookingId && String(b.id) === String(excludeBookingId)) return;
      ranges.push({ start: b.check_in, end: b.check_out, source: 'ACME', label: b.guest_name });
    });
    checked.push('ACME');
  } catch (e) { errors.push('Prenotazioni ACME non lette: ' + e.message); }

  const sources = await getIcalSources();
  await Promise.all([['booking', 'Booking'], ['airbnb', 'Airbnb']].map(async ([key, name]) => {
    if (!sources[key]) return;
    try {
      (await fetchIcal(sources[key])).forEach(e => {
        if ((to && e.start >= to) || (from && e.end <= from)) return;
        ranges.push({ start: e.start, end: e.end, source: name, label: e.summary || 'Occupato' });
      });
      checked.push(name);
    } catch (e) { errors.push(`Calendario ${name} non raggiungibile (${e.message})`); }
  }));
  ranges.sort((a, b) => a.start.localeCompare(b.start));
  return { ranges, errors, checked };
}

// Soggiorni che si sovrappongono a [checkIn, checkOut): il giorno di check-out
// di uno può essere il check-in del successivo.
export function conflictsWith(ranges, checkIn, checkOut) {
  return ranges.filter(r => r.start < checkOut && r.end > checkIn);
}

// Testo compatto per l'IA: "dal 12 al 19 ottobre 2026; dal 1 al 3 novembre 2026"
// (senza nomi degli ospiti: all'IA serve solo sapere quali notti sono prese)
export function occupiedText(ranges) {
  const fmt = (iso, withYear) => new Date(iso + 'T12:00:00Z').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  // Unisce gli intervalli che si toccano o si sovrappongono
  const merged = [];
  ranges.slice().sort((a, b) => a.start.localeCompare(b.start)).forEach(r => {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) { if (r.end > last.end) last.end = r.end; }
    else merged.push({ start: r.start, end: r.end });
  });
  return merged.map(r => `- notti dal ${fmt(r.start)} al ${fmt(r.end, true)} (check-out il ${fmt(r.end)})`).join('\n');
}

// Feed iCal delle prenotazioni dirette, da incollare in Booking e Airbnb
// ("importa calendario") così le date prese tramite ACME si chiudono anche lì.
// Solo le prenotazioni ACME: rimandare indietro quelle importate creerebbe
// un'eco tra i portali.
export function buildFeed(bookings) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Domus 106//ACME//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Domus 106 - prenotazioni dirette'];
  bookings.forEach(b => {
    lines.push('BEGIN:VEVENT', `UID:acme-booking-${b.id}@domus106`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${b.check_in.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${b.check_out.replace(/-/g, '')}`,
      'SUMMARY:Prenotazione diretta', 'END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
