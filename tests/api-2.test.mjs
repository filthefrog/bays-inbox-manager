// Test degli endpoint con fetch simulato: nessuna rete, nessun dato vero.
// Si lanciano con: npm test
process.env.SUPABASE_URL='https://sb.test'; process.env.SUPABASE_SERVICE_KEY='k';
const R=new URL('../', import.meta.url).pathname;
let calls=[]; let script=()=>null;
globalThis.fetch=async (url,opt={})=>{ calls.push({url:String(url),opt}); const o=script(String(url),opt)||{status:200,body:[]};
  return { ok:o.status<300, status:o.status, json:async()=>o.body, text:async()=>typeof o.body==='string'?o.body:JSON.stringify(o.body) }; };
const mkres=()=>{const r={code:0,body:null,headers:{}}; r.status=c=>{r.code=c;return r}; r.json=b=>{r.body=b;return r}; r.send=b=>{r.body=b;return r}; r.setHeader=(k,v)=>{r.headers[k]=v}; return r;};
const ok=(c,m,x)=>{ console.log((c?'PASS':'FAIL')+' '+m+(c||x===undefined?'':' → '+JSON.stringify(x))); if(!c) process.exitCode=1; };
const booking=(await import(R+'api/booking.js')).default;
const av=await import(R+'lib/availability.js');
const ICS_BOOKING='BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261017\r\nSUMMARY:CLOSED - Not\r\n  available\r\nEND:VEVENT\r\nEND:VCALENDAR';
const ICS_AIRBNB='BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261104\nSUMMARY:Reserved\nEND:VEVENT\nEND:VCALENDAR';
const state={ gmail_refresh_token:'VERO', ical_import: JSON.stringify({booking:'https://b.test/ical', airbnb:'https://a.test/ical'}), ical_feed_token:'TOK' };
script=(u,o)=>{
  const m=u.match(/app_state\?id=eq\.([^&]+)/); if(m) return {status:200,body: state[decodeURIComponent(m[1])]!=null?[{value:state[decodeURIComponent(m[1])]}]:[]};
  if(u.includes('app_state?on_conflict')){ const b=JSON.parse(o.body); state[b.id]=b.value; return {status:201,body:''}; }
  if(u==='https://b.test/ical') return {status:200,body:ICS_BOOKING};
  if(u==='https://a.test/ical') return {status:200,body:ICS_AIRBNB};
  if(u.includes('confirmed_bookings?select=id,guest_name,check_in,check_out,status')) return {status:200,body:[{id:7,guest_name:'Maria',check_in:'2026-10-12',check_out:'2026-10-14',status:'confermata'}]};
  if(u.includes('confirmed_bookings?select=id,check_in,check_out')) return {status:200,body:[{id:7,check_in:'2026-10-12',check_out:'2026-10-14'}]};
  return null; };
const auth={gmail_refresh:'VERO'};
// parse
const ev=av.parseIcs(ICS_BOOKING); ok(ev[0].start==='2026-10-15'&&ev[0].end==='2026-10-17'&&ev[0].summary==='CLOSED - Not available','iCal: date e riga spezzata lette', ev);
// availability: overlaps ACME + Booking
let res=mkres(); await booking({method:'GET',query:{availability:'1',checkIn:'2026-10-13',checkOut:'2026-10-16'},cookies:auth},res);
ok(res.code===200 && res.body.conflicts.map(c=>c.source).join()==='ACME,Booking','disponibilità: conflitti ACME e Booking trovati', res.body);
res=mkres(); await booking({method:'GET',query:{availability:'1',checkIn:'2026-10-14',checkOut:'2026-10-15'},cookies:auth},res);
ok(res.body.conflicts.length===0,'check-out e check-in nello stesso giorno: nessun conflitto', res.body);
res=mkres(); await booking({method:'GET',query:{availability:'1',checkIn:'2026-11-03',checkOut:'2026-11-05'},cookies:auth},res);
ok(res.body.conflicts.length===1 && res.body.conflicts[0].source==='Airbnb','disponibilità: conflitto Airbnb', res.body);
// feed
res=mkres(); await booking({method:'GET',query:{feed:'SBAGLIATO'},cookies:{}},res); ok(res.code===404,'feed con codice sbagliato: 404');
res=mkres(); await booking({method:'GET',query:{feed:'TOK'},cookies:{}},res);
ok(res.code===200 && res.body.includes('DTSTART;VALUE=DATE:20261012') && !res.body.includes('Maria'),'feed per i portali: date sì, nomi no', res.body);
// settings: webcal convertito, http rifiutato
res=mkres(); await booking({method:'POST',query:{},cookies:auth,body:{saveCalendarSettings:true,booking:'webcal://b.test/ical',airbnb:''}},res);
ok(res.code===200 && JSON.parse(state.ical_import).booking==='https://b.test/ical','impostazioni: webcal:// diventa https://', res.body);
res=mkres(); await booking({method:'POST',query:{},cookies:auth,body:{saveCalendarSettings:true,booking:'http://x',airbnb:''}},res);
ok(res.code===400,'impostazioni: link non https rifiutato');
// schemaMissing fallback
let posts=[]; script=(u,o)=>{ if(u.includes('app_state')) return {status:200,body:[{value:'VERO'}]};
  if(u.includes('confirmed_bookings')&&o.method==='POST'){ const b=JSON.parse(o.body); posts.push(b); return 'rooms' in b ? {status:400,body:`{"code":"PGRST204","message":"Could not find the 'rooms' column"}`} : {status:201,body:[{id:1,code:'X'}]}; } return null; };
res=mkres(); await booking({method:'POST',query:{},cookies:auth,body:{guestName:'A',checkIn:'2026-10-01',checkOut:'2026-10-03',rooms:2,amountPaid:50}},res);
ok(res.code===200 && res.body.schemaMissing===true && posts.length===2,'database non aggiornato: salva lo stesso senza camere/incassato', res.body);
// quote api: pdf da listino
const quote=(await import(R+'api/quote.js')).default;
res=mkres(); await quote({method:'POST',body:{action:'pdf',guestName:'Bianchi',checkIn:'2026-07-12',checkOut:'2026-07-19',guests:4},cookies:{}},res);
ok(res.code===200 && res.body.total===1096 && res.body.quote.rooms===2,'preventivo PDF dal listino: 1.096 € con seconda camera', {code:res.code,total:res.body&&res.body.total});
res=mkres(); await quote({method:'POST',body:{action:'pdf',guestName:'Bianchi',checkIn:'2026-07-12',checkOut:'2026-07-19',guests:4,rooms:1},cookies:{}},res);
ok(res.code===400,'4 ospiti con una camera: rifiutato');
// AI prompt riceve le date occupate
const an=await import(R+'lib/analyze-email.js'); let prompt='';
script=(u,o)=>{ if(u.includes('anthropic')){ prompt=JSON.parse(o.body).messages[0].content; return {status:200,body:{content:[{text:'{"category":"Prenotazione","tone":"Cortese","discrepancy":null,"response_cortese":"a","response_fermo":"b","response_deciso":"c"}'}]}}; } return null; };
await an.analyzeAndRespond({from:'x',subject:'y',body:'z'},'k',{today:'2026-10-03',occupied:av.occupiedText([{start:'2026-10-12',end:'2026-10-14'},{start:'2026-10-13',end:'2026-10-17'}])});
ok(prompt.includes('DATE GIÀ OCCUPATE') && prompt.includes('dal 12 ottobre al 17 ottobre 2026') && prompt.includes('Seconda camera'),'IA: riceve date occupate (unite) e listino', prompt.slice(0,0));
