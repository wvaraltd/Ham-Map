import http from 'node:http';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Pool } from 'pg';

const PORT = Number(process.env.PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const DATABASE_URL = process.env.DATABASE_URL;
const INGEST_TOKEN = process.env.WSJTX_INGEST_TOKEN || '';
const SECRETS_KEY = Buffer.from(process.env.SECRETS_KEY || '', 'hex');
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (SECRETS_KEY.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes encoded as hex');

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const loginAttempts = new Map();
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const feedCache = new Map();

const json = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const cleanCall = value => String(value || '').trim().toUpperCase();
const validCall = value => /^[A-Z0-9]{1,3}[0-9][A-Z0-9/]{1,10}$/.test(value);
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
const body = async req => {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
};
const passwordHash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const safeEqual = (a, b) => {
  const aa = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const encryptSecret = value => {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', SECRETS_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
};
async function operatorCount() {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM operators');
  return rows[0].count;
}
async function auth(req) {
  const token = cookies(req).hammap_session;
  if (!token) return null;
  const { rows } = await pool.query(`SELECT o.id,o.callsign FROM sessions s JOIN operators o ON o.id=s.operator_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha256(token)]);
  return rows[0] || null;
}
async function createSession(res, operator) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM sessions WHERE expires_at<=now()');
  await pool.query(`INSERT INTO sessions(token_hash,operator_id,expires_at) VALUES($1,$2,now()+($3||' seconds')::interval)`, [sha256(token), operator.id, SESSION_SECONDS]);
  const cookie = `hammap_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
  json(res, 200, { authenticated: true, callsign: operator.callsign }, { 'set-cookie': cookie });
}
function requireSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  if (!host || new URL(origin).host !== host) throw Object.assign(new Error('Origin rejected'), { status: 403 });
}
function adifField(name, value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);
  return `<${name}:${Buffer.byteLength(text, 'utf8')}>${text}`;
}
function adifDate(d) { return d.toISOString().slice(0,10).replaceAll('-',''); }
function adifTime(d) { return d.toISOString().slice(11,19).replaceAll(':',''); }
async function remoteJson(url, ttlMs = 120000) {
  const cached = feedCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.data;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent':'HamMap/0.2 WV8CH', accept:'application/json, application/geo+json' } });
  if (!response.ok) throw Object.assign(new Error(`Upstream feed returned ${response.status}`), { status:502 });
  const text = await response.text();
  if (text.length > 8_000_000) throw Object.assign(new Error('Upstream feed is too large'), { status:502 });
  const data = JSON.parse(text); feedCache.set(url,{data,expires:Date.now()+ttlMs}); return data;
}
function latestNumeric(rows, valueColumn) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const headers = rows[0];
  if (!Array.isArray(headers)) { const value=rows.at(-1)?.[valueColumn] ?? rows.at(-1)?.[valueColumn.toLowerCase()]; const n=Number(value); return Number.isFinite(n)?n:null; }
  const index = headers.indexOf(valueColumn);
  if(index < 0)return null;
  const n=Number(rows.at(-1)?.[index]);return Number.isFinite(n)?n:null;
}
async function feedSources() {
  const { rows }=await pool.query('SELECT data FROM settings ORDER BY operator_id LIMIT 1');
  return rows[0]?.data?.feedSources||{};
}
function privateAddress(address) {
  if(net.isIPv4(address))return /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return address==='::1'||address.startsWith('fc')||address.startsWith('fd')||address.startsWith('fe80:');
}
async function checkedFeedUrl(raw,{local=false}={}) {
  let target;try{target=new URL(String(raw||''));}catch{throw Object.assign(new Error('Enter a valid source URL'),{status:400});}
  if(local?!['http:','https:'].includes(target.protocol):target.protocol!=='https:')throw Object.assign(new Error(local?'Source must use HTTP or HTTPS':'Internet sources must use HTTPS'),{status:400});
  if(!local){const addresses=await dns.lookup(target.hostname,{all:true});if(addresses.some(row=>privateAddress(row.address)))throw Object.assign(new Error('Private network addresses are not allowed for this source'),{status:400});}
  return target.toString();
}
async function configuredSource(key) {
  const source=(await feedSources())[key]||{};
  if(source.provider==='disabled'||!source.provider)throw Object.assign(new Error(`${key} source is disabled`),{status:503});
  return source;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/callsign/lookup' && req.method === 'GET') {
      const call=String(url.searchParams.get('call')||'').trim().toUpperCase();
      if(!/^[A-Z0-9]{3,10}$/.test(call))return json(res,400,{error:'Invalid callsign'});
      try {
        const data=await remoteJson('https://callook.info/'+encodeURIComponent(call)+'/json',3600000);
        const loc=data.location||{};
        return json(res,200,{found:data.status==='VALID',callsign:call,grid:loc.gridsquare||loc.grid||'',latitude:loc.latitude??null,longitude:loc.longitude??null,source:'Callook/FCC'});
      } catch {return json(res,502,{error:'Callsign lookup unavailable'});}
    }
    if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'ham-map', database: true });
    if (url.pathname === '/api/live/pota' && req.method === 'GET') {const source=(await feedSources()).pota;if(source?.provider==='disabled')return json(res,503,{error:'POTA source is disabled'});return json(res,200,{spots:await remoteJson('https://api.pota.app/spot/activator',60000)});}
    if (url.pathname === '/api/live/repeaters' && req.method === 'GET') {
      const data=await remoteJson('https://ara.radio/repeaters.json',300000);
      if(!Array.isArray(data))throw Object.assign(new Error('ARA repeater directory returned invalid data'),{status:502});
      return json(res,200,{repeaters:data.filter(r=>r.is_public!==0 && !r.deleted_at).map(r=>({id:r.id,callsign:r.callsign,frequency:r.frequency,input_frequency:r.input_frequency,offset:r.offset,tone:r.tone,band:r.band,mode:r.mode,location_name:r.location_name,nearest_city:r.nearest_city,county:r.county,state:r.state,club_affiliate:r.club_affiliate,status:r.status,latitude:r.latitude,longitude:r.longitude,needs_review:r.needs_review,notes:r.notes}))});
    }
    if (url.pathname === '/api/live/sota' && req.method === 'GET') {
      const source=await configuredSource('sota');if(source.provider!=='custom')return json(res,503,{error:'SOTA source is not configured'});
      return json(res,200,{spots:await remoteJson(await checkedFeedUrl(source.url),60000)});
    }
    if (url.pathname === '/api/live/nws' && req.method === 'GET') {
      if((await feedSources()).nws?.provider==='disabled')return json(res,503,{error:'NWS source is disabled'});
      const area=String(url.searchParams.get('area')||'WV').toUpperCase();
      if(!/^[A-Z]{2}$/.test(area))return json(res,400,{error:'Invalid weather area'});
      return json(res,200,await remoteJson(`https://api.weather.gov/alerts/active?area=${area}`,60000));
    }
    if (url.pathname === '/api/live/aurora' && req.method === 'GET') {
      const data=await remoteJson('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',300000);
      if(!Array.isArray(data.coordinates))throw Object.assign(new Error('NOAA aurora grid unavailable'),{status:502});
      return json(res,200,{source:'NOAA SWPC OVATION',observation_time:data['Observation Time']||null,forecast_time:data['Forecast Time']||null,coordinates:data.coordinates});
    }
    if (url.pathname === '/api/live/solar' && req.method === 'GET') {
      if((await feedSources()).solar?.provider==='disabled')return json(res,503,{error:'Solar source is disabled'});
      const [kp,cycle,mag]=await Promise.all([
        remoteJson('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',120000),
        remoteJson('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json',900000),
        remoteJson('https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json',120000).catch(()=>null)
      ]);
      const recent=Array.isArray(cycle)?cycle.at(-1):{};
      return json(res,200,{kp:latestNumeric(kp,'Kp'),solarFlux:Number(recent?.['f10.7']),sunspots:Number(recent?.ssn),bz:mag?latestNumeric(mag,'BZ'):null});
    }
    if (url.pathname === '/api/live/satellite/catalog' && req.method === 'GET') {
      const groups=['amateur','stations','cubesat'];
      const results=await Promise.allSettled(groups.map(group=>remoteJson('https://celestrak.org/NORAD/elements/gp.php?GROUP='+group+'&FORMAT=JSON',3600000)));
      const entries=new Map();
      for(let i=0;i<results.length;i++){
        const result=results[i];if(result.status!=='fulfilled'||!Array.isArray(result.value))continue;
        for(const item of result.value){
          const norad=Number(item.NORAD_CAT_ID);
          if(!Number.isSafeInteger(norad)||norad<1||norad>999999||!item.EPOCH)continue;
          const category=groups[i];
          const existing=entries.get(norad);
          if(!existing)entries.set(norad,{norad,name:String(item.OBJECT_NAME||'NORAD '+norad).slice(0,100),categories:[category]});
          else if(!existing.categories.includes(category))existing.categories.push(category);
        }
      }
      if(!entries.size)return json(res,502,{error:'CelesTrak satellite catalog unavailable'});
      return json(res,200,{source:'CelesTrak',satellites:[...entries.values()].sort((a,b)=>a.name.localeCompare(b.name)),groups:groups.filter((_,i)=>results[i].status==='fulfilled'),note:'Catalog group membership does not verify amateur-radio transmitter activity'});
    }
    if (url.pathname === '/api/live/satellite/lookup' && req.method === 'GET') {
      const raw=String(url.searchParams.get('norad')||'').trim();
      if(!/^[1-9][0-9]{0,5}$/.test(raw))return json(res,400,{error:'Enter a valid NORAD catalog number'});
      const norad=Number(raw);
      const data=await remoteJson('https://celestrak.org/NORAD/elements/gp.php?CATNR='+norad+'&FORMAT=JSON',3600000);
      if(!Array.isArray(data)||!data[0]?.EPOCH)return json(res,404,{error:'No current orbital elements found'});
      return json(res,200,{name:String(data[0].OBJECT_NAME||'NORAD '+norad).slice(0,100),norad,elements:data[0],source:'CelesTrak'});
    }
    if (url.pathname === '/api/live/satellites' && req.method === 'GET') {
      const raw=String(url.searchParams.get('ids')||'25544,27607,44909');
      if(raw.length>400)return json(res,400,{error:'Satellite list too long'});
      const ids=[...new Set(raw.split(',').map(x=>x.trim()))];
      if(!ids.length||ids.length>20||ids.some(x=>!/^[1-9][0-9]{0,5}$/.test(x)))return json(res,400,{error:'Provide 1–20 valid NORAD catalog numbers'});
      const entries=await Promise.allSettled(ids.map(async id=>{
        const norad=Number(id);
        const data=await remoteJson('https://celestrak.org/NORAD/elements/gp.php?CATNR='+norad+'&FORMAT=JSON',3600000);
        if(!Array.isArray(data)||!data[0]?.EPOCH)throw new Error('Orbital elements unavailable');
        return {name:String(data[0].OBJECT_NAME||'NORAD '+norad).slice(0,100),norad,elements:data[0]};
      }));
      const satellites=entries.filter(x=>x.status==='fulfilled').map(x=>x.value);
      if(!satellites.length)return json(res,502,{error:'No orbital elements available for selected satellites'});
      return json(res,200,{source:'CelesTrak GP orbital elements',satellites,unavailable:ids.filter(id=>!satellites.some(x=>x.norad===Number(id))),updated:new Date().toISOString()});
    }
    if (url.pathname === '/api/live/iss' && req.method === 'GET') {
      const source=await configuredSource('iss');let endpoint;
      if(source.provider==='wheretheiss')endpoint='https://api.wheretheiss.at/v1/satellites/25544';else if(source.provider==='custom')endpoint=await checkedFeedUrl(source.url);else return json(res,503,{error:'ISS source is not configured'});
      return json(res,200,await remoteJson(endpoint,15000));
    }
    if (url.pathname === '/api/live/psk' && req.method === 'GET') {
      const call=cleanCall(url.searchParams.get('call'));
      if(!validCall(call))return json(res,400,{error:'Enter a valid station callsign'});
      const key='psk:'+call, cached=feedCache.get(key);
      if(cached && cached.expires>Date.now())return json(res,200,cached.data);
      const endpoint='https://retrieve.pskreporter.info/query?'+new URLSearchParams({callsign:call,flowStartSeconds:'-1800',rptlimit:'500',rronly:'1',noactive:'1'});
      const response=await fetch(endpoint,{signal:AbortSignal.timeout(20000),headers:{'user-agent':'HamMap/0.3 (amateur radio dashboard)','accept':'application/xml,text/xml,*/*'}});
      if(!response.ok)throw Object.assign(new Error('PSK Reporter returned HTTP '+response.status),{status:502});
      const xml=await response.text();
      if(xml.length>5000000)throw Object.assign(new Error('PSK Reporter response too large'),{status:502});
      if(!xml.includes('<receptionReports'))throw Object.assign(new Error('Invalid PSK Reporter XML'),{status:502});
      const reports=[];
      for(const match of xml.matchAll(new RegExp('<receptionReport\\s+([^>]*?)/?>','gi'))){
        const attributes={};
        for(const attr of match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g))attributes[attr[1]]=attr[2];
        const freq=Number(attributes.frequency);
        if(!Number.isFinite(freq)||freq<=0)continue;
        reports.push({senderCallsign:attributes.senderCallsign||'',receiverCallsign:attributes.receiverCallsign||'',senderLocator:attributes.senderLocator||'',receiverLocator:attributes.receiverLocator||'',frequency:freq,mode:attributes.mode||'',time:Number(attributes.flowStartSeconds)||0,snr:attributes.sNR??attributes.snr??null});
      }
      const data={source:'PSK Reporter',callsign:call,reports,updated:new Date().toISOString()};
      feedCache.set(key,{data,expires:Date.now()+300000});
      return json(res,200,data);
    }
    if (url.pathname === '/api/live/dx' && req.method === 'GET') {const source=await configuredSource('dx');if(source.provider!=='custom')return json(res,503,{error:'DX source is not configured'});return json(res,200,await remoteJson(await checkedFeedUrl(source.url),30000));}
    if (url.pathname === '/api/live/mesh' && req.method === 'GET') {const source=await configuredSource('mesh');if(source.provider!=='custom')return json(res,503,{error:'Mesh source is not configured'});return json(res,200,await remoteJson(await checkedFeedUrl(source.url,{local:true}),15000));}
    if (url.pathname === '/api/live/allstar' && req.method === 'GET') {
      const source=await configuredSource('allstar');
      if(source.provider==='custom')return json(res,200,await remoteJson(await checkedFeedUrl(source.url),30000));
      const node=String(source.node||'').replace(/\D/g,'').slice(0,8);if(!node)return json(res,400,{error:'Invalid AllStar node'});
      const response=await fetch(`https://stats.allstarlink.org/stats/${node}`,{signal:AbortSignal.timeout(12000),headers:{'user-agent':'HamMap/0.3 WV8CH'}});const page=await response.text();
      return json(res,200,{node,online:response.ok&&!/not reporting statistical data or is offline/i.test(page),source:'AllStarLink Stats'});
    }
    if ((url.pathname === '/api/boundaries/states' || url.pathname === '/api/boundaries/counties') && req.method === 'GET') {
      if((await feedSources()).boundaries?.provider==='disabled')return json(res,503,{error:'Boundary source is disabled'});
      const parts=String(url.searchParams.get('bbox')||'').split(',').map(Number);
      if(parts.length!==4||parts.some(v=>!Number.isFinite(v)))return json(res,400,{error:'Invalid bounding box'});
      const [west,south,east,north]=parts;
      if(west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north)return json(res,400,{error:'Invalid bounding box'});
      const isCounty=url.pathname.endsWith('/counties'), layer=isCounty?1:0;
      const query=new URLSearchParams({where:'1=1',geometry:`${west},${south},${east},${north}`,geometryType:'esriGeometryEnvelope',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'*',returnGeometry:'true',maxAllowableOffset:isCounty?'0.002':'0.01',f:'geojson'});
      const endpoint=`https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/${layer}/query?${query}`;
      const boundaryResponse=await fetch(endpoint,{signal:AbortSignal.timeout(20000),headers:{'user-agent':'curl/8.0','accept':'*/*'}});
      if(!boundaryResponse.ok)throw Object.assign(new Error('Census boundary service HTTP '+boundaryResponse.status),{status:502});
      const boundaryText=await boundaryResponse.text();
      if(boundaryText.length>16000000)throw Object.assign(new Error('Census boundary response too large'),{status:502});
      const boundaryData=JSON.parse(boundaryText);
      if(boundaryData.type!=='FeatureCollection'||!Array.isArray(boundaryData.features))throw Object.assign(new Error('Census boundary query failed: '+(boundaryData.error?.message||'Invalid GeoJSON response')),{status:502});
      return json(res,200,boundaryData);
    }
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      const user = await auth(req); return json(res, 200, { authenticated: Boolean(user), setupRequired: (await operatorCount()) === 0, callsign: user?.callsign || null });
    }
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') {
      requireSameOrigin(req);
      if (await operatorCount()) return json(res, 409, { error: 'Operator account already exists' });
      const data = await body(req), callsign = cleanCall(data.callsign), password = String(data.password || '');
      if (!validCall(callsign)) return json(res, 400, { error: 'Enter a valid amateur-radio callsign' });
      if (password.length < 4) return json(res, 400, { error: 'Password must contain at least 4 characters' });
      const salt = crypto.randomBytes(24).toString('hex');
      const { rows } = await pool.query('INSERT INTO operators(callsign,password_salt,password_hash) VALUES($1,$2,$3) RETURNING id,callsign', [callsign, salt, passwordHash(password, salt)]);
      await pool.query('INSERT INTO settings(operator_id,data) VALUES($1,$2)', [rows[0].id, JSON.stringify({ callsign })]);
      return createSession(res, rows[0]);
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      requireSameOrigin(req);
      const ip = req.socket.remoteAddress || 'unknown', state = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (state.until > Date.now()) return json(res, 429, { error: 'Too many attempts. Try again later.' });
      const data = await body(req), callsign = cleanCall(data.callsign), password = String(data.password || '');
      const { rows } = await pool.query('SELECT id,callsign,password_salt,password_hash FROM operators WHERE callsign=$1', [callsign]);
      const row = rows[0], ok = row && safeEqual(passwordHash(password, row.password_salt), row.password_hash);
      if (!ok) {
        state.count += 1; if (state.count >= 5) { state.until = Date.now() + 15 * 60_000; state.count = 0; } loginAttempts.set(ip, state);
        return json(res, 401, { error: 'Invalid callsign or password' });
      }
      loginAttempts.delete(ip); return createSession(res, row);
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      requireSameOrigin(req); const token = cookies(req).hammap_session; if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sha256(token)]);
      return json(res, 200, { authenticated: false }, { 'set-cookie': 'hammap_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (url.pathname === '/api/ingest/wsjtx' && req.method === 'POST') {
      if (!INGEST_TOKEN || req.headers.authorization !== `Bearer ${INGEST_TOKEN}`) return json(res, 401, { error: 'Invalid ingestion token' });
      const data = await body(req), callsign = cleanCall(data.stationCallsign), contact = cleanCall(data.callsign);
      const { rows } = await pool.query('SELECT id,callsign FROM operators LIMIT 1'); const user = rows[0];
      if (!user || callsign !== user.callsign || !validCall(contact)) return json(res, 400, { error: 'Invalid station or contact callsign' });
      const result = await insertQso(user, { ...data, call: contact, source: 'wsjtx' });
      return json(res, result.duplicate ? 200 : 201, result);
    }
    const user = await auth(req);
    if (!user) return json(res, 401, { error: 'Authentication required' });
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      const { rows } = await pool.query('SELECT data FROM settings WHERE operator_id=$1', [user.id]); return json(res, 200, rows[0]?.data || {});
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      requireSameOrigin(req); const data = await body(req);
      if (data.callsign) {
        const requestedCallsign = cleanCall(data.callsign);
        if (!validCall(requestedCallsign)) return json(res, 400, { error: 'Enter a valid station callsign' });
        await pool.query('UPDATE operators SET callsign=$1,updated_at=now() WHERE id=$2', [requestedCallsign,user.id]);
      }
      await pool.query(`INSERT INTO settings(operator_id,data,updated_at) VALUES($1,$2,now()) ON CONFLICT(operator_id) DO UPDATE SET data=excluded.data,updated_at=now()`, [user.id, JSON.stringify(data)]);
      return json(res, 200, { saved: true });
    }
    if (url.pathname === '/api/feeds/test' && req.method === 'POST') {
      requireSameOrigin(req);const data=await body(req),sources=data.feedSources||{},results={};
      for(const key of ['sota','dx','iss','allstar','mesh']){const source=sources[key]||{};if(source.provider!=='custom'){results[key]={ok:source.provider!=='disabled',message:source.provider==='disabled'?'Disabled':'Built-in provider selected'};continue;}try{const endpoint=await checkedFeedUrl(source.url,{local:key==='mesh'});const response=await fetch(endpoint,{signal:AbortSignal.timeout(10000),headers:{'user-agent':'HamMap/0.3 WV8CH',accept:'application/json'}});results[key]={ok:response.ok,message:`HTTP ${response.status}`};}catch(error){results[key]={ok:false,message:error.message};}}
      return json(res,200,{results});
    }
    if (url.pathname === '/api/qsos' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 1000);
      const { rows } = await pool.query('SELECT * FROM qsos WHERE operator_id=$1 ORDER BY qso_time DESC LIMIT $2', [user.id, limit]); return json(res, 200, { qsos: rows });
    }
    if (url.pathname === '/api/qsos' && req.method === 'POST') {
      requireSameOrigin(req); const data = await body(req), result = await insertQso(user, data); return json(res, result.duplicate ? 200 : 201, result);
    }
    if (url.pathname === '/api/qsos/adif' && req.method === 'GET') {
      const { rows } = await pool.query('SELECT * FROM qsos WHERE operator_id=$1 ORDER BY qso_time', [user.id]);
      const header = 'Generated by Ham Map\r\n<ADIF_VER:5>3.1.4<PROGRAMID:7>HAM-MAP<EOH>\r\n';
      const records = rows.map(q => { const d = new Date(q.qso_time); return [adifField('CALL',q.contact_callsign),adifField('STATION_CALLSIGN',q.station_callsign),adifField('QSO_DATE',adifDate(d)),adifField('TIME_ON',adifTime(d)),adifField('BAND',q.band),adifField('FREQ',q.frequency_mhz),adifField('MODE',q.mode),adifField('RST_SENT',q.rst_sent),adifField('RST_RCVD',q.rst_received),adifField('MY_GRIDSQUARE',q.station_grid),adifField('GRIDSQUARE',q.contact_grid),q.pota_reference?adifField('MY_SIG','POTA'):'',adifField('MY_SIG_INFO',q.pota_reference),adifField('MY_SOTA_REF',q.sota_reference),adifField('COMMENT',q.notes),'<EOR>'].filter(Boolean).join('') }).join('\r\n');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="ham-map-log.adi"', 'cache-control': 'no-store' }); return res.end(header + records + '\r\n');
    }
    if (url.pathname === '/api/notifications/pushover/test' && req.method === 'POST') {
      requireSameOrigin(req); const data = await body(req), token = String(data.appToken || ''), key = String(data.userKey || '');
      if (!token || !key) return json(res, 400, { error: 'Pushover keys are required' });
      const form = new URLSearchParams({ token, user: key, title: 'Ham Map', message: `Test notification for ${user.callsign}` });
      const response = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
      if (!response.ok) return json(res, 502, { error: 'Pushover rejected the test notification' });
      await pool.query(`INSERT INTO notification_settings(operator_id,pushover_user_key,pushover_app_token,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(operator_id) DO UPDATE SET pushover_user_key=excluded.pushover_user_key,pushover_app_token=excluded.pushover_app_token,updated_at=now()`, [user.id,encryptSecret(key),encryptSecret(token)]);
      return json(res, 200, { sent: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error); return json(res, error.status || 500, { error: error.status ? error.message : 'Server error' });
  }
}

async function insertQso(user, data) {
  const call = cleanCall(data.call || data.callsign), station = user.callsign;
  if (!validCall(call)) throw Object.assign(new Error('Enter a valid contact callsign'), { status: 400 });
  const rawTime=data.time || data.qsoTime || Date.now();
  const time = new Date(typeof rawTime==='string'&&!/[zZ]|[+-]\d\d:?\d\d$/.test(rawTime)?`${rawTime}Z`:rawTime); if (Number.isNaN(time.getTime())) throw Object.assign(new Error('Invalid QSO time'), { status: 400 });
  const source = String(data.source || 'manual').slice(0,24), uid = data.sourceUid ? String(data.sourceUid).slice(0,160) : null;
  const values = [user.id,station,call,time,data.freq||data.frequencyMhz||null,data.band||null,String(data.mode||'OTHER').toUpperCase(),data.sent||data.rstSent||null,data.received||data.rstReceived||null,data.grid||data.stationGrid||null,data.contactGrid||null,data.operationMode||'home',data.potaRef||data.potaReference||null,data.sotaRef||data.sotaReference||null,data.activationName||null,data.notes||null,source,uid];
  const sql=`INSERT INTO qsos(operator_id,station_callsign,contact_callsign,qso_time,frequency_mhz,band,mode,rst_sent,rst_received,station_grid,contact_grid,operation_mode,pota_reference,sota_reference,activation_name,notes,source,source_uid) VALUES(${values.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT(operator_id,source,source_uid) WHERE source_uid IS NOT NULL DO NOTHING RETURNING id`;
  const { rows } = await pool.query(sql, values); return rows[0] ? { saved: true, id: rows[0].id } : { saved: true, duplicate: true };
}

await pool.query('SELECT 1');
http.createServer(handler).listen(PORT, HOST, () => console.log(`Ham Map API listening on http://${HOST}:${PORT}`));
