// Test degli endpoint con fetch simulato: nessuna rete, nessun dato vero.
// Si lanciano con: npm test
process.env.SUPABASE_URL='https://sb.test'; process.env.SUPABASE_SERVICE_KEY='k';
process.env.CRON_SECRET='s'; process.env.ANTHROPIC_API_KEY='a';
const R=new URL('../', import.meta.url).pathname;
let calls=[]; let script=()=>null;
globalThis.fetch=async (url,opt={})=>{ calls.push({url:String(url),opt}); const r=script(String(url),opt); const o=r||{status:200,body:[]};
  return { ok:o.status<300, status:o.status, json:async()=>o.body, text:async()=>typeof o.body==='string'?o.body:JSON.stringify(o.body) }; };
const mkres=()=>{const r={code:0,body:null,headers:{}}; r.status=c=>{r.code=c;return r}; r.json=b=>{r.body=b;return r}; r.send=b=>{r.body=b;return r}; r.setHeader=(k,v)=>{r.headers[k]=v}; r.redirect=u=>{r.code=302;r.body=u;return r}; return r;};
const ok=(c,m,x)=>{ console.log((c?'PASS':'FAIL')+' '+m+(c||x===undefined?'':' → '+JSON.stringify(x))); if(!c) process.exitCode=1; };
const booking=(await import(R+'api/booking.js')).default;

// 1 senza cookie -> 401
let res=mkres(); await booking({method:'GET',query:{},cookies:{}},res); ok(res.code===401,'booking senza login: 401');
// 2 cookie falso: supabase dice altro token, google rifiuta -> 401
script=(u)=> u.includes('app_state')?{status:200,body:[{value:'VERO'}]}: u.includes('oauth2')?{status:400,body:{error:'invalid_grant'}}:null;
res=mkres(); await booking({method:'GET',query:{},cookies:{gmail_refresh:'FALSO'}},res); ok(res.code===401,'booking con cookie falso: 401');
// 3 cookie giusto -> 200
script=(u)=> u.includes('app_state')?{status:200,body:[{value:'VERO'}]}: u.includes('confirmed_bookings')?{status:200,body:[{id:1}]}:null;
res=mkres(); await booking({method:'GET',query:{},cookies:{gmail_refresh:'VERO'}},res); ok(res.code===200&&res.body.bookings.length===1,'booking con login: 200');
// 4 ICS senza login, con note "pericolose"
res=mkres(); await booking({method:'GET',query:{ics:'1',guestName:'Rossi, Maria',checkIn:'2026-10-12',checkOut:'2026-10-19',notes:'riga1\nriga2; ok'},cookies:{}},res);
ok(res.code===200 && res.body.includes(String.raw`riga1\nriga2\; ok`) && res.body.includes(String.raw`Rossi\, Maria`),'ICS senza login e con testo escapato');
// 5 errore Supabase generico non ritentato 3 volte
calls=[]; script=(u,o)=> u.includes('app_state')?{status:200,body:[{value:'VERO'}]}: (u.includes('confirmed_bookings')&&o.method==='POST')?{status:400,body:'{"code":"PGRST204","message":"Could not find column"}'}:null;
res=mkres(); await booking({method:'POST',query:{},cookies:{gmail_refresh:'VERO'},body:{guestName:'A',checkIn:'2026-10-01',checkOut:'2026-10-03'}},res);
ok(res.code===500 && calls.filter(c=>c.opt.method==='POST').length===1 && /PGRST204/.test(res.body.error),'errore Supabase: niente finti tentativi, messaggio vero');
// 6 collisione vera ritentata
let n=0; script=(u,o)=> u.includes('app_state')?{status:200,body:[{value:'VERO'}]}: (u.includes('confirmed_bookings')&&o.method==='POST')?(++n<2?{status:409,body:'{"code":"23505","message":"duplicate key"}'}:{status:201,body:[{code:'X'}]}):null;
res=mkres(); await booking({method:'POST',query:{},cookies:{gmail_refresh:'VERO'},body:{guestName:'A',checkIn:'2026-10-01',checkOut:'2026-10-03'}},res);
ok(res.code===200 && n===2,'collisione di codice: ritenta e salva');
// 7 DELETE fallito -> 500
script=(u,o)=> u.includes('app_state')?{status:200,body:[{value:'VERO'}]}: o.method==='DELETE'?{status:500,body:'boom'}:null;
res=mkres(); await booking({method:'DELETE',query:{},cookies:{gmail_refresh:'VERO'},body:{id:5}},res); ok(res.code===500,'cancellazione fallita: errore, non finto ok');

// 8 send-email: thread
const send=(await import(R+'api/send-email.js')).default;
calls=[]; script=(u)=> u.includes('oauth2')?{status:200,body:{access_token:'t'}}: u.includes('/send')?{status:200,body:{id:'m1',threadId:'th'}}:{status:200,body:{labelIds:['SENT']}};
res=mkres(); await send({method:'POST',cookies:{gmail_refresh:'x'},body:{to:'a@b.it',subject:'Re: Ciao',body:'testo',threadId:'th9',inReplyTo:'<abc@mail.gmail.com>'}},res);
const sent=JSON.parse(calls.find(c=>c.url.includes('/send')).opt.body); const raw=Buffer.from(sent.raw,'base64url').toString();
ok(sent.threadId==='th9' && raw.includes('In-Reply-To: <abc@mail.gmail.com>') && raw.includes('References: <abc@mail.gmail.com>'),'risposta nello stesso thread');
calls=[]; res=mkres(); await send({method:'POST',cookies:{gmail_refresh:'x'},body:{to:'a@b.it',subject:'x',body:'y',inReplyTo:'<a>\r\nBcc: evil@x.it'}},res);
const raw2=Buffer.from(JSON.parse(calls.find(c=>c.url.includes('/send')).opt.body).raw,'base64url').toString();
ok(!raw2.includes('Bcc') && !raw2.includes('In-Reply-To'),'Message-ID malformato scartato (niente intestazioni iniettate)');

// 9 check-urgent: promemoria una volta al giorno dopo le 14
const cu=(await import(R+'api/check-urgent.js')).default;
const RealDTF=Intl.DateTimeFormat;
const hourNow=Number(new RealDTF('en-GB',{timeZone:'Europe/Rome',hour:'2-digit',hour12:false}).format(new Date()));
let pushes=0, saved=null;
script=(u,o)=>{ if(u.includes('checkout_reminder_date')) return {status:200,body:saved?[{value:saved}]:[]};
  if(u.includes('app_state?on_conflict')){ saved=JSON.parse(o.body).value; return {status:201,body:''}; }
  if(u.includes('check_out=eq.')) return {status:200,body:[{guest_name:'Maria',code:'D1'}]};
  if(u.includes('push_subscriptions')){ pushes++; return {status:200,body:[]}; }
  if(u.includes('gmail_refresh_token')) return {status:200,body:[]};
  return null; };
res=mkres(); await cu({headers:{},query:{secret:'s'}},res); const r1=res.body.checkoutReminder;
res=mkres(); await cu({headers:{},query:{secret:'s'}},res); const r2=res.body.checkoutReminder;
if (hourNow>=14 && hourNow<22) ok(r1.attempted && r1.sent===1 && !r2.attempted,`promemoria 14:00: inviato una volta (ora ${hourNow})`);
else ok(!r1.attempted,`promemoria fuori orario non parte (ora ${hourNow})`);

// 10 analyze: categoria fuori elenco -> Da verificare
const an=await import(R+'lib/analyze-email.js');
script=(u)=> u.includes('anthropic')?{status:200,body:{content:[{type:'text',text:'{"category":"Spam","tone":"Neutro","discrepancy":null,"response_cortese":"a","response_fermo":"b","response_deciso":"c"}'}]}}:null;
const out=await an.analyzeAndRespond({from:'x',subject:'y',body:'z'},'k'); ok(out.category==='Da verificare','categoria sconosciuta finisce in Da verificare');

// 11 callback senza debug
const cb=(await import(R+'api/callback.js')).default; process.env.GOOGLE_CLIENT_ID='c'; process.env.GOOGLE_CLIENT_SECRET='s';
script=(u)=> u.includes('oauth2')?{status:200,body:{access_token:'t',refresh_token:'r',scope:'x'}}:{status:201,body:''};
res=mkres(); await cb({query:{code:'abc'}},res); ok(res.body==='/','login: redirect pulito senza banner di debug');
