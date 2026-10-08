(() => {
  const $ = id => document.getElementById(id);
  const layerButton = name => document.querySelector(`[data-layer="${name}"]`);
  const enabled = name => layerButton(name)?.classList.contains('on');
  const safe = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const station = { lat: Number($('latitude')?.value) || 0, lon: Number($('longitude')?.value) || 0 };
  let selectedBand = '20m';
  let measureArmed = false;
  let pathLine = null;
  let liveSuccesses = 0;
  let liveFailures = 0;

  const earthquakesLayer=L.layerGroup();
  const radarLayer=L.layerGroup();
  leafletLayers.earthquakes=earthquakesLayer;
  leafletLayers.radar=radarLayer;
  async function loadEarthquakes(){
    try{
      const data=await getJson('/api/live/earthquakes');
      earthquakesLayer.clearLayers();
      let count=0;
      for(const quake of data.features||[]){
        const [lon,lat]=quake.geometry?.coordinates||[],mag=Number(quake.properties?.mag);
        if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(mag))continue;
        const color=mag>=6?'#ff4969':mag>=4.5?'#ffad52':'#f8d774';
        const point=L.circleMarker([lat,lon],{radius:Math.max(3,Math.min(15,mag*1.8)),color,weight:1,fillColor:color,fillOpacity:.4});
        const when=Number(quake.properties?.time);
        point.bindPopup('<strong>M '+safe(mag.toFixed(1))+'</strong><br>'+safe(quake.properties?.place||'Unknown location')+'<br>'+safe(Number.isFinite(when)?new Date(when).toLocaleString():'Time unavailable')+'<br>Source: USGS');
        earthquakesLayer.addLayer(point);count++;
      }
      rowStatus('earthquakes',count+' past 24h','ok');
    }catch{rowStatus('earthquakes','feed offline','warn');}
  }
  async function loadRadar(){
    try{
      const data=await getJson('/api/live/radar');
      radarLayer.clearLayers();
      const url='https://tilecache.rainviewer.com'+data.path+'/256/{z}/{x}/{y}/2/1_1.png';
      radarLayer.addLayer(L.tileLayer(url,{opacity:.62,maxNativeZoom:7,maxZoom:9,attribution:'Weather radar © <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>'}));
      rowStatus('radar',new Date(data.time*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),'ok');
    }catch{rowStatus('radar','feed offline','warn');}
  }
    const auroraLayer = L.layerGroup();
  leafletLayers.aurora = auroraLayer;
  const repeatersLayer = L.layerGroup();
  leafletLayers.repeaters = repeatersLayer;
  const statesLayer = L.geoJSON(null, { style: { color:'#7bc8ff', weight:1.25, opacity:.9, fillOpacity:0 } });
  const countiesLayer = L.geoJSON(null, { style: { color:'#9ec2cf', weight:.7, opacity:.65, fillOpacity:0 } });
  const grayLayer = L.polyline(solarNightRing(), { color:'#ffe0a1', weight:10, opacity:.18, interactive:false });
  const gridMapLayer = L.layerGroup();
  const labelsLayer = L.layerGroup();
  leafletLayers.states = statesLayer;
  leafletLayers.counties = countiesLayer;
  leafletLayers.gray = grayLayer;
  leafletLayers.grid = gridMapLayer;
  leafletLayers.labels = labelsLayer;

  for (const layer of [pathLayer, weatherLayer, satelliteLayer, dxLayer, meshcoreLayer, potaLayer, sotaLayer]) layer.clearLayers();
  if (enabled('states')) statesLayer.addTo(radioMap);
  if (enabled('gray')) grayLayer.addTo(radioMap);

  function setFeedState(ok, text) {
    ok ? liveSuccesses++ : liveFailures++;
    const node = $('liveStatus');
    if (!node) return;
    node.childNodes[1].nodeValue = liveSuccesses ? ' LIVE FEEDS ' : ' FEEDS OFFLINE ';
    $('lastUpdate').textContent = `• ${text || (liveFailures ? `${liveFailures} unavailable` : 'updated now')}`;
    node.querySelector('.dot').style.background = liveSuccesses ? 'var(--mint)' : 'var(--red)';
  }
  async function getJson(path) {
    const response = await fetch(path, { headers:{ accept:'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Feed error ${response.status}`);
    return data;
  }
  function rowStatus(name,text,tone='') {
    const row=layerButton(name)?.closest('.toggle-row'); if(!row)return;
    let note=row.querySelector('.layer-state');
    if(!note){note=document.createElement('span');note.className='layer-state';row.insertBefore(note,layerButton(name));}
    note.textContent=text;note.className=`layer-state ${tone}`;
  }
  function updateCounters() {
    document.querySelectorAll('#layersPanel .group').forEach(group=>{
      const count=[...group.querySelectorAll('[data-layer]')].filter(button=>button.classList.contains('on')&&!button.disabled).length;
      const target=group.querySelector('.group-head .count'); if(target)target.textContent=`${count} ON`;
    });
  }
  function setLayer(name, on) {
    const button = layerButton(name), layer = leafletLayers[name];
    if(button?.disabled)on=false;
    button?.classList.toggle('on', on);
    if (!layer) return;
    if (on && !radioMap.hasLayer(layer)) layer.addTo(radioMap);
    if (!on && radioMap.hasLayer(layer)) radioMap.removeLayer(layer);
    updateCounters();
  }
  function maidenhead(lat,lon,precision){
    let x=(lon+180+360)%360,y=Math.max(0,Math.min(179.999999,lat+90)),out='';
    const chars='ABCDEFGHIJKLMNOPQR',sub='abcdefghijklmnopqrstuvwx';
    out+=chars[Math.floor(x/20)]+chars[Math.floor(y/10)];x%=20;y%=10;
    if(precision>=4){out+=Math.floor(x/2)+''+Math.floor(y);x%=2;y%=1;}
    if(precision>=6)out+=sub[Math.min(23,Math.floor(x*12))]+sub[Math.min(23,Math.floor(y*24))];
    return out;
  }
  function drawGrid(){
    gridMapLayer.clearLayers();
    const zoom=radioMap.getZoom(),stepLon=zoom>=11?1/12:zoom>=6?2:20,stepLat=zoom>=11?1/24:zoom>=6?1:10;
    const precision=zoom>=11?6:zoom>=6?4:2,bounds=radioMap.getBounds();
    const west=Math.max(-180,bounds.getWest()),east=Math.min(180,bounds.getEast()),south=Math.max(-90,bounds.getSouth()),north=Math.min(90,bounds.getNorth());
    const cols=Math.ceil((east-west)/stepLon),rows=Math.ceil((north-south)/stepLat);
    if(cols*rows>1100){rowStatus('grid','zoom in','warn');return;}
    const startLon=Math.floor((west+180)/stepLon)*stepLon-180,startLat=Math.floor((south+90)/stepLat)*stepLat-90;
    for(let x=startLon;x<=east+stepLon;x+=stepLon)gridMapLayer.addLayer(L.polyline([[south,x],[north,x]],{color:'#79d5ed',weight:1,opacity:.72,interactive:false}));
    for(let y=startLat;y<=north+stepLat;y+=stepLat)gridMapLayer.addLayer(L.polyline([[y,west],[y,east]],{color:'#79d5ed',weight:1,opacity:.72,interactive:false}));
    let labels=0;
    for(let x=startLon;x<east;x+=stepLon)for(let y=startLat;y<north;y+=stepLat){
      const center=[y+stepLat/2,x+stepLon/2];
      if(!bounds.contains(center)||labels++>=180)continue;
      const code=maidenhead(center[0],center[1],precision);
      gridMapLayer.addLayer(L.marker(center,{interactive:false,icon:L.divIcon({className:'hammap-grid-label',html:'<span style="font:600 11px sans-serif;color:#d8f8ff;text-shadow:0 1px 3px #071522">'+code+'</span>',iconSize:[0,0]})}));
    }
    rowStatus('grid',precision+'-char grid','ok');
  }
  drawGrid();
  layerButton('grid')?.addEventListener('click',()=>setTimeout(()=>{if(enabled('grid'))drawGrid();},0));
  layerButton('earthquakes')?.addEventListener('click',()=>setTimeout(()=>{if(enabled('earthquakes'))loadEarthquakes();},0));
  layerButton('radar')?.addEventListener('click',()=>setTimeout(()=>{if(enabled('radar'))loadRadar();},0));
  setInterval(()=>{if(enabled('earthquakes'))loadEarthquakes();if(enabled('radar'))loadRadar();},5*60*1000);
    radioMap.on('moveend zoomend',()=>{if(enabled('grid'))drawGrid();});
  async function loadBoundaries(kind) {
    const layer = kind === 'states' ? statesLayer : countiesLayer;
    if (kind === 'counties' && radioMap.getZoom() < 5) { rowStatus(kind,'zoom in','warn'); return; }
    const b = radioMap.getBounds();
    try {
      const data = await getJson(`/api/boundaries/${kind}?bbox=${[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()].map(n=>n.toFixed(4)).join(',')}`);
      layer.clearLayers().addData(data);
      layer.eachLayer(item => item.bindTooltip(item.feature?.properties?.NAME || kind, { sticky:true, className:'ham-tip' }));
      rowStatus(kind,`${data.features?.length||0} loaded`,'ok');
      setFeedState(true, `${kind} updated`);
    } catch { rowStatus(kind,'feed offline','warn'); setFeedState(false, `${kind} unavailable`); }
  }

  function normalizeSpot(raw, kind) {
    const lat = Number(raw.latitude ?? raw.lat ?? raw.Latitude);
    const lon = Number(raw.longitude ?? raw.lon ?? raw.lng ?? raw.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const call = raw.activator || raw.activatorCallsign || raw.callsign || raw.call || 'Unknown';
    const ref = raw.reference || raw.referenceNumber || raw.parkReference || raw.summitCode || raw.associationCode || '';
    const rawFreq = String(raw.frequency || raw.freq || '').replace(/\s*(MHz|kHz)\s*/ig,'');
    const freq = Number(rawFreq)>1000?(Number(rawFreq)/1000).toFixed(3):rawFreq;
    const mode = raw.mode || '';
    const band = bandFor(Number(freq) > 1000 ? Number(freq)/1000 : freq);
    return { lat, lon, call, ref, freq, mode, band, kind };
  }
  let callsignPoints=[];
  function updateCallsignLabels(){
    labelsLayer.clearLayers();
    if(!enabled('labels'))return;
    const zoom=radioMap.getZoom(),minGap=zoom>=9?45:zoom>=6?75:110;
    const seen=[];
    for(const p of callsignPoints){
      if(!p.call||!Number.isFinite(p.lat)||!Number.isFinite(p.lon))continue;
      if(!radioMap.getBounds().contains([p.lat,p.lon]))continue;
      const xy=radioMap.latLngToContainerPoint([p.lat,p.lon]);
      if(seen.some(q=>Math.abs(q.x-xy.x)<minGap&&Math.abs(q.y-xy.y)<24))continue;
      seen.push(xy);
      labelsLayer.addLayer(L.marker([p.lat,p.lon],{interactive:false,icon:L.divIcon({className:'hammap-call-label',html:'<span style="display:inline-block;white-space:nowrap;background:#091d2ce6;color:#e4f8ff;border:1px solid #3b718a;border-radius:4px;padding:1px 4px;font:600 11px sans-serif">'+safe(p.call)+'</span>',iconSize:[0,0],iconAnchor:[-9,-8]})}));
      if(seen.length>=180)break;
    }
    rowStatus('labels',seen.length+' visible','ok');
  }
  function renderPortable(layer, spots, kind) {
    layer.clearLayers();
    const normalized=spots.map(x=>normalizeSpot(x,kind)).filter(Boolean).filter(x=>!selectedBand || !x.band || x.band===selectedBand);
    for (const spot of normalized) {
      layer.addLayer(L.marker([spot.lat,spot.lon],{icon:portableIcon(kind)}).bindTooltip(`${safe(spot.call)} • ${kind.toUpperCase()} ${safe(spot.ref)} • ${safe(spot.freq)} ${safe(spot.mode)}`,{className:'ham-tip'}));
    }
    callsignPoints=callsignPoints.filter(p=>p.kind!==kind).concat(normalized.map(p=>({...p,kind})));
    updateCallsignLabels();
    return normalized;
  }
  async function loadPortable() {
    const all=[];
    for (const [kind,layer] of [['pota',potaLayer],['sota',sotaLayer]]) {
      try { const data = await getJson(`/api/live/${kind}`); if(data.disabled){layer.clearLayers();rowStatus(kind,'not configured');continue;} const spots=renderPortable(layer, data.spots || data, kind);all.push(...spots);rowStatus(kind,`${spots.length} spots`,'ok');setFeedState(true, `${kind.toUpperCase()} updated`); }
      catch { layer.clearLayers();setLayer(kind,false);rowStatus(kind,'feed offline','warn');setFeedState(false, `${kind.toUpperCase()} unavailable`); }
    }
    const card=$('portableSpotsCard'), list=$('portableSpotList');
    card.querySelector('.status').textContent=`${all.length} ON ${selectedBand}`;
    list.innerHTML=all.slice(0,4).map(s=>`<div class="activity"><div><div class="call">${safe(s.call)}</div><div class="meta">${s.kind.toUpperCase()} • ${safe(s.ref)}</div></div><div class="freq">${safe(s.freq)}</div></div>`).join('')||`<p class="meta">No geolocated ${selectedBand} activators were returned.</p>`;
  }
  async function loadWeather() {
    try {
      const data = await getJson(`/api/live/nws?area=${encodeURIComponent($('weatherArea').value)}`);
      weatherLayer.clearLayers();
      for (const feature of data.features || []) if (feature.geometry) weatherLayer.addLayer(L.geoJSON(feature,{style:{color:'#ff5f64',fillColor:'#ff5f64',fillOpacity:.22,weight:2}}).bindTooltip(feature.properties?.event || 'NWS alert',{className:'ham-tip'}));
      rowStatus('weather',`${data.features?.length||0} alerts`,data.features?.length?'warn':'ok');
      setFeedState(true, 'weather updated');
    } catch { weatherLayer.clearLayers();setLayer('weather',false);rowStatus('weather','feed offline','warn');setFeedState(false, 'weather unavailable'); }
  }
  async function loadSolar() {
    try {
      const data = await getJson('/api/live/solar');
      $('solarFlux').textContent = data.solarFlux ?? '—'; $('kpIndex').textContent = data.kp ?? '—'; $('sunspots').textContent = data.sunspots ?? '—'; $('bzValue').textContent = data.bz == null ? '—' : `${data.bz} nT`;
      $('solarCard').querySelector('.status').textContent = data.kp >= 5 ? 'STORM' : data.kp >= 4 ? 'ACTIVE' : 'QUIET';
      setFeedState(true, 'space weather updated');
    } catch { $('solarCard').querySelector('.status').textContent = 'UNAVAILABLE'; setFeedState(false, 'space weather unavailable'); }
  }
  function currentFeedSources() { const value=id=>$(id)?.value||'';return {sota:{provider:value('sotaProvider'),url:value('sotaUrl')},dx:{provider:value('dxProvider'),url:value('dxUrl')},iss:{provider:value('issProvider'),url:value('issUrl')},allstar:{provider:value('allstarProvider'),url:value('allstarUrl'),node:value('allstarNode')},mesh:{provider:value('meshProvider'),url:value('meshUrl')}}; }
  function pskGridPoint(grid){
    const g=String(grid||'').toUpperCase();
    if(!/^[A-R]{2}[0-9]{2}([A-X]{2})?/.test(g))return null;
    let lon=(g.charCodeAt(0)-65)*20-180+Number(g[2])*2;
    let lat=(g.charCodeAt(1)-65)*10-90+Number(g[3]);
    let dx=2,dy=1;
    if(g.length>=6){lon+=(g.charCodeAt(4)-65)/12;lat+=(g.charCodeAt(5)-65)/24;dx=1/12;dy=1/24;}
    return [lat+dy/2,lon+dx/2];
  }
  function pskBand(hz){
    const mhz=Number(hz)/1e6;
    for(const [name,low,high] of [['160m',1.8,2],['80m',3.5,4],['60m',5.3,5.5],['40m',7,7.3],['30m',10.1,10.15],['20m',14,14.35],['17m',18.068,18.168],['15m',21,21.45],['12m',24.89,24.99],['10m',28,29.7],['6m',50,54],['2m',144,148],['70cm',420,450]])if(mhz>=low&&mhz<=high)return name;
    return '';
  }
  let pskReports=[];
  function updateDxCard(state='ok'){
    const card=$('dxCard');if(!card)return;
    const badge=card.querySelector('.status'),detail=card.querySelector('.meta');
    if($('dxProvider')?.value==='custom'){
      badge.textContent='CUSTOM FEED';
      detail.textContent='DX cluster is configured; view its spots on the map.';
      return;
    }
    const call=$('callsign')?.value?.trim().toUpperCase();
    if(!call){badge.textContent='SET CALLSIGN';detail.textContent='Enter your station callsign in Settings to load PSK Reporter reception spots.';return;}
    if(state==='offline'){badge.textContent='FEED OFFLINE';detail.textContent='PSK Reporter is temporarily unavailable. Retrying automatically.';return;}
    if(!pskReports.length){badge.textContent='NO RECENT SPOTS';detail.textContent='No PSK Reporter receptions involving '+call+' in the last 30 minutes. Checking again automatically.';return;}
    const recent=[...pskReports].sort((a,b)=>Number(b.time||0)-Number(a.time||0));
    const current=recent[0],band=pskBand(current.frequency);
    badge.textContent=pskReports.length+' REPORTS';
    detail.textContent=(current.senderCallsign||'?')+' → '+(current.receiverCallsign||'?')+' • '+(band||((Number(current.frequency)/1e6).toFixed(3)+' MHz'))+' • '+(current.mode||'digital')+' • '+pskReports.length+' receptions in 30 min';
  }
    function renderPsk(){
    if($('dxProvider')?.value==='custom')return;
    dxLayer.clearLayers();
    const mode=document.querySelector('.digital-filter.on')?.dataset.digitalMode||'ALL';
    const filtered=pskReports.filter(r=>pskBand(r.frequency)===selectedBand&&(mode==='ALL'||String(r.mode||'').toUpperCase()===mode));
    for(const r of filtered.slice(0,500)){
      const tx=pskGridPoint(r.senderLocator),rx=pskGridPoint(r.receiverLocator);
      if(!tx||!rx)continue;
      const label=safe(r.senderCallsign)+' → '+safe(r.receiverCallsign)+' · '+(Number(r.frequency)/1e6).toFixed(4)+' MHz · '+safe(r.mode);
      dxLayer.addLayer(L.polyline([tx,rx],{color:'#5bd4ed',weight:1,opacity:.4,interactive:false}));
      dxLayer.addLayer(L.circleMarker(tx,{radius:3,color:'#5bd4ed',fillOpacity:.7}).bindTooltip(label,{className:'ham-tip'}));
    }
    callsignPoints=callsignPoints.filter(p=>p.kind!=='psk').concat(filtered.flatMap(r=>{const tx=pskGridPoint(r.senderLocator),rx=pskGridPoint(r.receiverLocator);return [[tx,r.senderCallsign],[rx,r.receiverCallsign]].filter(x=>x[0]).map(x=>({lat:x[0][0],lon:x[0][1],call:x[1],kind:'psk'}));}));
    updateCallsignLabels();
    rowStatus('dx',filtered.length+' '+(mode==='ALL'?'digital':mode)+' reports','ok');
    updateDxCard();
    document.querySelectorAll('.band').forEach(button=>{
      const band=button.querySelector('strong')?.textContent?.trim();
      if(!band)return;
      const count=pskReports.filter(r=>pskBand(r.frequency)===band).length;
      button.title=count+' PSK Reporter receptions in last 30 minutes for station callsign';
    });
  }
  async function loadPsk(){
    if($('dxProvider')?.value==='custom')return;
    const call=$('callsign')?.value?.trim().toUpperCase();
    if(!call){rowStatus('dx','enter callsign');updateDxCard();return;}
    try{
      const data=await getJson('/api/live/psk?call='+encodeURIComponent(call));
      pskReports=Array.isArray(data.reports)?data.reports:[];
      renderPsk();
    }catch{rowStatus('dx','feed offline','warn');updateDxCard('offline');}
  }
  function updateSourceFields() {
    document.querySelectorAll('[data-source-url]').forEach(field=>{const name=field.dataset.sourceUrl,select=$(`${name}Provider`);field.hidden=select?.value!=='custom';});
    for(const [sourceName,layerName] of [['sota','sota'],['allstar','allstar'],['mesh','meshcore']]){const button=layerButton(layerName),configured=$(`${sourceName}Provider`)?.value!=='disabled';if(button){button.disabled=!configured;button.setAttribute('aria-disabled',String(!configured));if(!configured)setLayer(layerName,false);}const row=button?.closest('.toggle-row');if(row){row.style.opacity=configured?'1':'.55';rowStatus(layerName,configured?'ready':'not set',configured?'ok':'');}}
    const satButton=layerButton('satellite');if(satButton){satButton.disabled=false;satButton.removeAttribute('aria-disabled');satButton.closest('.toggle-row')?.style.removeProperty('opacity');}
    updateCounters();
  }
  async function testDataSources() {
    const button=$('testDataSources');button.disabled=true;button.textContent='Testing…';
    try{const response=await fetch('/api/feeds/test',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({feedSources:currentFeedSources()})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Test failed');const failed=Object.entries(data.results).filter(([,result])=>!result.ok);toast(failed.length?`${failed.map(([name])=>name.toUpperCase()).join(', ')} failed; check URLs`:'Configured sources passed');}
    catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Test configured sources';}
  }
  const satelliteColors={25544:'#b7a4ff',27607:'#59e1ce',44909:'#ffbf76'};
  const defaultSatellites=[{norad:25544,name:'ISS'},{norad:27607,name:'SO-50'},{norad:44909,name:'RS-44'}];
  let trackedSatellites=defaultSatellites.map(x=>({...x})),satelliteCatalog=[];
  function satellitePrefs(){
    return {ids:trackedSatellites.map(x=>x.norad),satellites:trackedSatellites.map(x=>({...x})),
      footprints:$('satelliteFootprints')?.checked!==false,tracks:$('satelliteTracks')?.checked!==false,passes:$('satellitePasses')?.checked!==false};
  }
  function persistSatellitePrefs(){localStorage.setItem('hammap-satellites',JSON.stringify(satellitePrefs()));lastSatellitePrefs=localStorage.getItem('hammap-satellites');}
  function drawSatelliteSelection(){
    const list=$('satelliteSelectionList');if(!list)return;
    list.replaceChildren();
    for(const sat of trackedSatellites){
      const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px';
      const name=document.createElement('span');name.textContent=sat.name+' (NORAD '+sat.norad+')';
      const remove=document.createElement('button');remove.type='button';remove.className='test';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+sat.name);
      remove.addEventListener('click',()=>{trackedSatellites=trackedSatellites.filter(x=>x.norad!==sat.norad);drawSatelliteSelection();persistSatellitePrefs();loadSatellites();});
      row.append(name,remove);list.append(row);
    }
    if(!trackedSatellites.length)list.textContent='No satellites selected. Search by NORAD number to add one.';
  }
  function restoreSatellitePrefs(){
    try{
      const p=JSON.parse(localStorage.getItem('hammap-satellites')||'null');
      if(p){
        const saved=Array.isArray(p.satellites)?p.satellites:
          Array.isArray(p.ids)?p.ids.map(id=>typeof id==='string'?defaultSatellites.find(x=>x.name===id):defaultSatellites.find(x=>x.norad===id)).filter(Boolean):null;
        if(saved)trackedSatellites=saved.filter(x=>Number.isSafeInteger(x.norad)&&x.norad>0&&x.norad<=999999&&typeof x.name==='string').slice(0,20);
        for(const [id,key] of [['satelliteFootprints','footprints'],['satelliteTracks','tracks'],['satellitePasses','passes']])if(typeof p[key]==='boolean')$(id).checked=p[key];
      }
    }catch{}
    drawSatelliteSelection();
  }
  function satellitePoint(record,date){
    const pv=window.satellite.propagate(record,date);
    if(!pv.position||!Number.isFinite(pv.position.x))return null;
    const gmst=window.satellite.gstime(date);
    const geo=window.satellite.eciToGeodetic(pv.position,gmst);
    return {lat:window.satellite.degreesLat(geo.latitude),lon:window.satellite.degreesLong(geo.longitude),height:geo.height,eci:pv.position,gmst};
  }
  function satelliteElevation(point){
    const observer={latitude:station.lat*Math.PI/180,longitude:station.lon*Math.PI/180,height:0};
    const ecef=window.satellite.eciToEcf(point.eci,point.gmst);
    return window.satellite.ecfToLookAngles(observer,ecef).elevation*180/Math.PI;
  }
  function satelliteNextPass(record,startMs=Date.now()){
    const step=60000,limit=24*60;
    let rise=null,max=-90,peak=null,previousAbove=false;
    for(let i=0;i<=limit;i++){
      const when=new Date(startMs+i*step),point=satellitePoint(record,when);
      if(!point)continue;
      const el=satelliteElevation(point),above=el>0;
      if(above){if(!previousAbove)rise=when;if(el>max){max=el;peak=when;}}
      else if(previousAbove&&rise)return {rise,peak,set:when,max,ongoing:rise.getTime()===startMs};
      previousAbove=above;
    }
    return null;
  }
  const passCache=new Map();
  function updateNextSatelliteCard(passList){
    const card=$('issCard');if(!card)return;
    const status=card.querySelector('.status'),detail=card.querySelector('.meta');
    if(!satellitePrefs().ids.length){status.textContent='NONE SELECTED';detail.textContent='Select satellites in Satellite Explorer.';return;}
    if(!$('callsign')?.value.trim()||!Number.isFinite(Number($('latitude')?.value))||!Number.isFinite(Number($('longitude')?.value))){
      status.textContent='SET QTH';detail.textContent='Configure your station latitude and longitude in Settings to calculate passes.';return;
    }
    if(!passList.length){status.textContent='NO PASS';detail.textContent='No above-horizon pass found in the next 24 hours for the selected satellites.';return;}
    passList.sort((a,b)=>a.pass.rise-b.pass.rise);
    const {name,pass}=passList[0],now=Date.now(),minutes=Math.max(0,Math.round((pass.rise-now)/60000));
    status.textContent=pass.ongoing?'OVERHEAD':minutes<1?'IMMINENT':'IN '+minutes+' MIN';
    const clock=d=>d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    detail.textContent=name+' • '+(pass.ongoing?'Currently above horizon':'Rise '+clock(pass.rise))+' • Set '+clock(pass.set)+' • Max elevation '+Math.round(pass.max)+'° (local time)';
  }
  function footprintPolygon(point){
    const R=6371,alt=Math.max(0,point.height),radius=Math.acos(R/(R+alt));
    const lat=point.lat*Math.PI/180,lon=point.lon*Math.PI/180,coords=[];
    for(let i=0;i<=96;i++){
      const bearing=i/96*2*Math.PI;
      const phi=Math.asin(Math.sin(lat)*Math.cos(radius)+Math.cos(lat)*Math.sin(radius)*Math.cos(bearing));
      const lambda=lon+Math.atan2(Math.sin(bearing)*Math.sin(radius)*Math.cos(lat),Math.cos(radius)-Math.sin(lat)*Math.sin(phi));
      coords.push([phi*180/Math.PI,((lambda*180/Math.PI+540)%360)-180]);
    }
    return coords;
  }
  function renderSatellites(){
    if(!window.satellite)return rowStatus('satellite','orbit library offline','warn');
    satelliteLayer.clearLayers();
    const prefs=satellitePrefs(),now=new Date(),results=[],upcoming=[];
    for(const item of satelliteCatalog){
      if(!prefs.ids.includes(item.norad))continue;
      try{
        const record=window.satellite.json2satrec(item.elements),point=satellitePoint(record,now);
        if(!point)continue;
        const color=satelliteColors[item.norad]||'#a78bfa';
        satelliteLayer.addLayer(L.circleMarker([point.lat,point.lon],{radius:7,color:'#fff',weight:1.5,fillColor:color,fillOpacity:1}).bindTooltip(item.name+' • '+Math.round(point.height*0.621371)+' mi',{permanent:true,className:'ham-tip'}));
        if(prefs.footprints){
          // Split at antimeridian to avoid long polygons across the world.
          const poly=footprintPolygon(point),segments=[[]];
          for(const coord of poly){const last=segments.at(-1);if(last.length&&Math.abs(coord[1]-last.at(-1)[1])>180)segments.push([]);segments.at(-1).push(coord);}
          for(const segment of segments)if(segment.length>2)satelliteLayer.addLayer(L.polyline(segment,{color,weight:1,opacity:.45,dashArray:'4 5',interactive:false}));
        }
        if(prefs.tracks){
          let segment=[],previous=null;
          for(let offset=-45;offset<=90;offset+=3){
            const p=satellitePoint(record,new Date(now.getTime()+offset*60000));if(!p)continue;
            if(previous&&Math.abs(p.lon-previous.lon)>180){if(segment.length>1)satelliteLayer.addLayer(L.polyline(segment,{color,weight:1.5,opacity:.7,interactive:false}));segment=[];}
            segment.push([p.lat,p.lon]);previous=p;
          }
          if(segment.length>1)satelliteLayer.addLayer(L.polyline(segment,{color,weight:1.5,opacity:.7,interactive:false}));
        }
        {
          const key=item.norad+':'+station.lat.toFixed(4)+':'+station.lon.toFixed(4);
          let cached=passCache.get(key);
          if(!cached||Date.now()-cached.calculated>180000||cached.pass&&cached.pass.set<Date.now()){
            cached={calculated:Date.now(),pass:satelliteNextPass(record)};
            passCache.set(key,cached);
          }
          const pass=cached.pass;
          if(pass)upcoming.push({name:item.name,pass});
          results.push(pass?item.name+': '+pass.rise.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'–'+pass.set.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+' (max '+Math.round(pass.max)+'° elevation)':item.name+': no pass predicted in 24 h');
        }
      }catch(e){results.push(item.name+': orbit unavailable');}
    }
    updateNextSatelliteCard(upcoming);
    if($('satellitePassResults'))$('satellitePassResults').textContent=prefs.passes?(results.join(' | ')||'No satellites selected'):'Pass predictions disabled';
    rowStatus('satellite',prefs.ids.length+' selected','ok');
  }
  let satelliteLoadSequence=0;
  async function loadSatellites(){
    const sequence=++satelliteLoadSequence,ids=satellitePrefs().ids;
    if(!ids.length){satelliteCatalog=[];satelliteLayer.clearLayers();updateNextSatelliteCard([]);rowStatus('satellite','none selected');if($('satellitePassResults'))$('satellitePassResults').textContent='No satellites selected';return;}
    try{
      const data=await getJson('/api/live/satellites?ids='+encodeURIComponent(ids.join(',')));
      if(sequence!==satelliteLoadSequence)return;
      satelliteCatalog=data.satellites||[];
      for(const sat of satelliteCatalog){const existing=trackedSatellites.find(x=>x.norad===sat.norad);if(existing)existing.name=sat.name;}
      drawSatelliteSelection();renderSatellites();
      if(data.unavailable?.length)rowStatus('satellite',data.unavailable.length+' orbits unavailable','warn');
    }catch{if(sequence===satelliteLoadSequence)rowStatus('satellite','orbit feed offline','warn');}
  }
  restoreSatellitePrefs();
  $('satelliteLookupBtn')?.addEventListener('click',async()=>{
    const input=$('satelliteNoradInput'),result=$('satelliteLookupResult'),raw=input.value.trim();
    if(!/^[1-9][0-9]{0,5}$/.test(raw)){result.textContent='Enter a valid NORAD catalog number.';return;}
    if(trackedSatellites.some(x=>x.norad===Number(raw))){result.textContent='This satellite is already tracked.';return;}
    if(trackedSatellites.length>=20){result.textContent='Maximum 20 satellites. Remove one first.';return;}
    const button=$('satelliteLookupBtn');button.disabled=true;result.textContent='Searching CelesTrak…';
    try{
      const data=await getJson('/api/live/satellite/lookup?norad='+encodeURIComponent(raw));
      if(input.value.trim()!==raw)return;
      const add=document.createElement('button');add.type='button';add.className='test';add.textContent='Add '+data.name;
      result.replaceChildren(document.createTextNode(data.name+' (NORAD '+data.norad+') '),add);
      add.addEventListener('click',()=>{
        if(trackedSatellites.some(x=>x.norad===data.norad)||trackedSatellites.length>=20)return;
        trackedSatellites.push({norad:data.norad,name:data.name});persistSatellitePrefs();drawSatelliteSelection();loadSatellites();result.textContent=data.name+' added to tracking.';
      });
    }catch(error){result.textContent='Lookup failed: '+error.message;}
    finally{button.disabled=false;}
  });
  for(const id of ['satelliteFootprints','satelliteTracks','satellitePasses'])$(id)?.addEventListener('change',()=>{persistSatellitePrefs();renderSatellites();});
  // Explorer saves to the same localStorage key; update this map on return or across tabs.
  let lastSatellitePrefs=localStorage.getItem('hammap-satellites');
  function syncSatelliteExplorer(){
    const current=localStorage.getItem('hammap-satellites');
    if(current===lastSatellitePrefs)return;
    lastSatellitePrefs=current;restoreSatellitePrefs();loadSatellites();
  }
  window.addEventListener('focus',syncSatelliteExplorer);
  window.addEventListener('storage',event=>{if(event.key==='hammap-satellites')syncSatelliteExplorer();});
    setInterval(()=>{if(enabled('satellite'))renderSatellites();},60000);
  setInterval(loadSatellites,3600000);
  async function loadConfiguredFeeds(){
    if($('dxProvider')?.value==='custom')try{const data=await getJson('/api/live/dx'),spots=Array.isArray(data)?data:(data.spots||[]);dxLayer.clearLayers();for(const raw of spots){const spot=normalizeSpot(raw,'dx');if(spot&&(!selectedBand||!spot.band||spot.band===selectedBand))dxLayer.addLayer(L.marker([spot.lat,spot.lon],{icon:icon('dx-dot')}).bindTooltip(`${safe(spot.call)} • ${safe(spot.freq)} ${safe(spot.mode)}`,{className:'ham-tip'}));}rowStatus('dx',`${dxLayer.getLayers().length} spots`,'ok');}catch{dxLayer.clearLayers();rowStatus('dx','offline','warn');}
    // Multi-satellite tracking is driven by selected CelesTrak orbital elements.
    if($('allstarProvider')?.value && $('allstarProvider').value!=='disabled')try{const data=await getJson('/api/live/allstar'),node=String(data.node||$('allstarNode').value);$('allstarNodeRing').textContent=node;$('allstarTitle').textContent=`AllStar node ${node}`;$('allstarCard').querySelector('.status').textContent=data.online?'ONLINE':'OFFLINE';$('allstarDetail').textContent=`Node ${node} • ${data.source||'configured source'}`;rowStatus('allstar',data.online?'online':'offline',data.online?'ok':'warn');}catch(error){const node=String($('allstarNode').value||'—');$('allstarNodeRing').textContent=node;$('allstarTitle').textContent=`AllStar node ${node}`;$('allstarCard').querySelector('.status').textContent='OFFLINE';$('allstarDetail').textContent='The configured AllStar source could not be reached.';rowStatus('allstar','offline','warn');}
    if($('meshProvider')?.value && $('meshProvider').value!=='disabled')try{const data=await getJson('/api/live/mesh'),nodes=Array.isArray(data)?data:(data.nodes||[]);meshcoreLayer.clearLayers();for(const node of nodes){const lat=Number(node.latitude??node.lat),lon=Number(node.longitude??node.lon??node.lng);if(Number.isFinite(lat)&&Number.isFinite(lon))meshcoreLayer.addLayer(L.marker([lat,lon],{icon:icon('mesh-dot')}).bindTooltip(safe(node.name||node.id||'Mesh node'),{className:'ham-tip'}));}rowStatus('meshcore',`${meshcoreLayer.getLayers().length} nodes`,'ok');}catch{meshcoreLayer.clearLayers();rowStatus('meshcore','offline','warn');}
  }

  function updateStation() {
    station.lat = Math.max(-90,Math.min(90,Number($('latitude').value) || 0));
    station.lon = Math.max(-180,Math.min(180,Number($('longitude').value) || 0));
    qthLayer.clearLayers().addLayer(L.marker([station.lat,station.lon],{icon:icon('pulse-marker')}).bindTooltip(`${safe($('callsign').value.toUpperCase())} • ${safe($('grid').value.toUpperCase())}`,{permanent:true,direction:'right',className:'ham-tip'}));
    $('stationCard').textContent = `${$('callsign').value.toUpperCase()} • ${$('location').value}`;
    $('stationCoords').textContent = `${Math.abs(station.lat).toFixed(2)}° ${station.lat>=0?'N':'S'}, ${Math.abs(station.lon).toFixed(2)}° ${station.lon>=0?'E':'W'} • Grid ${$('grid').value.toUpperCase()}`;
  }
  const oldSaveLocal = saveLocal;
  saveLocal = function() {
    const prefs = oldSaveLocal();
    prefs.latitude = Number($('latitude').value); prefs.longitude = Number($('longitude').value);
    prefs.activation = JSON.parse(localStorage.getItem('hammap-activation') || 'null');
    localStorage.setItem('hammap',JSON.stringify(prefs)); return prefs;
  };
  const oldLoadLocal = loadLocal;
  loadLocal = function() {
    oldLoadLocal();
    try { const p=JSON.parse(localStorage.getItem('hammap')||'{}'); if(Number.isFinite(p.latitude))$('latitude').value=p.latitude;if(Number.isFinite(p.longitude))$('longitude').value=p.longitude; } catch {}
    updateStation(); updateActivationState();
    if(satelliteCatalog.length)renderSatellites();
  };
  applyStation = updateStation;
  $('homeMap').onclick = () => radioMap.setView([station.lat,station.lon],8,{animate:true});

  function distanceBearing(a,b) {
    const r=Math.PI/180, p1=a.lat*r,p2=b.lat*r,dl=(b.lng-a.lng)*r;
    const x=Math.sin(dl)*Math.cos(p2), y=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
    const bearing=(Math.atan2(x,y)/r+360)%360;
    const d=6371*2*Math.asin(Math.sqrt(Math.sin((p2-p1)/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2));
    return { km:d, mi:d*.621371, bearing };
  }
  $('measureBtn').onclick = () => { measureArmed=true; $('measureBtn').textContent='Click destination…'; toast('Click the map to measure from your QTH'); };
  radioMap.on('click', event => {
    if (!measureArmed) return; measureArmed=false; $('measureBtn').textContent='↗ Path tool';
    if (pathLine) pathLayer.removeLayer(pathLine);
    pathLine=L.polyline([[station.lat,station.lon],event.latlng],{color:'#f6bd60',weight:3}).addTo(pathLayer);
    const m=distanceBearing({lat:station.lat,lng:station.lon},event.latlng);
    L.popup().setLatLng(event.latlng).setContent(`<strong>${m.mi.toFixed(0)} mi / ${m.km.toFixed(0)} km</strong><br>${m.bearing.toFixed(0).padStart(3,'0')}° true`).openOn(radioMap);
  });

  const presets={dx:['night','gray','states','pota'],prop:['night','gray','paths','grid'],sat:['night','states'],emergency:['states','counties','weather']};
  document.querySelectorAll('.preset').forEach(p=>p.onclick=()=>{
    document.querySelectorAll('.preset').forEach(x=>x.classList.toggle('active',x===p));
    const wanted=new Set(presets[p.dataset.preset]||[]); document.querySelectorAll('[data-layer]').forEach(b=>setLayer(b.dataset.layer,wanted.has(b.dataset.layer)));
    saveLocal(); if(wanted.has('counties'))loadBoundaries('counties'); toast(`${p.textContent} loaded`);
  });
  document.querySelectorAll('.band').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('.band').forEach(x=>x.classList.remove('active')); b.classList.add('active'); selectedBand=b.querySelector('strong').textContent; renderPsk(); $('bandContext').textContent=`${selectedBand} • live spots`; loadPortable();
  });

  function updateActivationState() {
    const a=JSON.parse(localStorage.getItem('hammap-activation')||'null');
    $('activationState').textContent=a?.active?`Active since ${new Date(a.started).toLocaleString()} • ${[a.potaRef,a.sotaRef].filter(Boolean).join(' + ')||a.name||'portable'}`:'No active portable session';
    $('startActivation').disabled=Boolean(a?.active); $('endActivation').disabled=!a?.active;
  }
  $('startActivation').onclick=()=>{
    if($('operationMode').value==='home')return toast('Choose a POTA or SOTA operating mode first');
    const a={active:true,started:new Date().toISOString(),mode:$('operationMode').value,potaRef:$('potaRef').value.trim().toUpperCase(),sotaRef:$('sotaRef').value.trim().toUpperCase(),grid:$('portableGrid').value.trim().toUpperCase(),name:$('activationName').value.trim()};
    if(!a.potaRef&&!a.sotaRef)return toast('Enter a park or summit reference'); localStorage.setItem('hammap-activation',JSON.stringify(a)); updateActivationState(); toast('Portable activation started');
  };
  $('endActivation').onclick=()=>{const a=JSON.parse(localStorage.getItem('hammap-activation')||'null');if(a){a.active=false;a.ended=new Date().toISOString();localStorage.setItem('hammap-activation',JSON.stringify(a));}updateActivationState();toast('Portable activation ended')};

  for (const name of ['dlayer','zones']) {
    const button=layerButton(name), row=button?.closest('.toggle-row');
    if(button){button.classList.remove('on');button.disabled=true;button.setAttribute('aria-disabled','true');}
    if(row){row.title='A live data source is not configured';row.style.opacity='.55';rowStatus(name,'not set');}
  }
  const labelsButton=layerButton('labels');
  if(labelsButton){labelsButton.disabled=false;labelsButton.removeAttribute('aria-disabled');labelsButton.closest('.toggle-row')?.style.removeProperty('opacity');rowStatus('labels','ready','ok');labelsButton.addEventListener('click',()=>setTimeout(updateCallsignLabels,0));}
  radioMap.on('moveend zoomend',updateCallsignLabels);
  // Render NOAA OVATION as a softly blended probability field instead of point markers.
  // The underlying values are forecast probabilities, not a photograph of aurora.
  function auroraImage(coordinates){
    const w=720,h=360,source=document.createElement('canvas');
    source.width=w;source.height=h;
    const ctx=source.getContext('2d'),pixels=ctx.createImageData(w,h);
    const intensity=new Float32Array(w*h);
    let active=0;
    for(const item of coordinates){
      if(!Array.isArray(item)||item.length<3)continue;
      const lon=Number(item[0]),lat=Number(item[1]),v=Number(item[2]);
      if(!Number.isFinite(lon)||!Number.isFinite(lat)||!Number.isFinite(v)||Math.abs(lat)>90||v<5)continue;
      const x=Math.round((((lon+180)%360+360)%360)/360*(w-1));
      const y=Math.max(0,Math.min(h-1,Math.round((90-lat)/180*(h-1))));
      const index=y*w+x;
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const px=(x+dx)%w,py=Math.min(h-1,y+dy),idx=py*w+px;
        intensity[idx]=Math.max(intensity[idx],Math.min(100,v));
      }
      active++;
    }
    // Fill each 1-degree NOAA cell as a 2x2-pixel tile; transparent below 5%.
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const v=intensity[y*w+x];
        if(v<5)continue;
        const t=Math.min(1,v/100),p=(y*w+x)*4;
        const warm=Math.max(0,(t-.32)/.68),pink=Math.max(0,(t-.68)/.32);
        pixels.data[p]=Math.round(45+190*warm+20*pink);
        pixels.data[p+1]=Math.round(215-90*warm-60*pink);
        pixels.data[p+2]=Math.round(112+25*warm+90*pink);
        pixels.data[p+3]=Math.round(Math.min(215,28+190*Math.pow(t,.8)));
      }
    }
    ctx.putImageData(pixels,0,0);
    const output=document.createElement('canvas');output.width=w;output.height=h;
    const out=output.getContext('2d');
    out.filter='blur(7px)';out.drawImage(source,0,0);
    out.filter='blur(2px)';out.globalAlpha=.8;out.drawImage(source,0,0);
    return {url:output.toDataURL('image/png'),active};
  }
  async function loadAurora(){
    try{
      const data=await getJson('/api/live/aurora');
      if(!Array.isArray(data.coordinates))throw new Error('Invalid aurora forecast');
      const image=auroraImage(data.coordinates);
      auroraLayer.clearLayers();
      auroraLayer.addLayer(L.imageOverlay(image.url,[[-90,-180],[90,180]],{opacity:.82,interactive:false,className:'hammap-aurora-glow'}));
      rowStatus('aurora',image.active+' forecast cells','ok');
      layerButton('aurora')?.closest('.toggle-row')?.setAttribute('title','NOAA OVATION probability glow; forecast '+(data.forecast_time||'latest available'));
    }catch{rowStatus('aurora','feed offline','warn');}
  }
  const auroraButton=layerButton('aurora');
  if(auroraButton){
    auroraButton.disabled=false;auroraButton.removeAttribute('aria-disabled');
    auroraButton.closest('.toggle-row')?.style.removeProperty('opacity');
    rowStatus('aurora','ready');
    auroraButton.addEventListener('click',()=>setTimeout(()=>{if(enabled('aurora'))loadAurora();},0));
    setInterval(()=>{if(enabled('aurora'))loadAurora();},300000);
  }
  async function loadRepeaters() {
    try {
      const data=await getJson('/api/live/repeaters');
      if(!Array.isArray(data.repeaters))throw new Error('Invalid repeater directory');
      repeatersLayer.clearLayers();
      let mapped=0;
      for(const r of data.repeaters){
        const lat=Number(r.latitude),lon=Number(r.longitude);
        if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180||(Math.abs(lat)<0.01&&Math.abs(lon)<0.01))continue;
        const status=String(r.status||'unknown').toLowerCase();
        const color=({active:'#28caa2',maintenance:'#ffbb55',degraded:'#ffbb55',offline:'#ef7474',planned:'#9ba9bc'})[status]||'#9ba9bc';
        const marker=L.circleMarker([lat,lon],{radius:6,color,weight:2,fillColor:color,fillOpacity:.8});
        const title=safe(r.callsign||'Repeater')+' · '+safe(r.frequency??'?')+' MHz';
        marker.bindPopup('<strong>'+title+'</strong><br>'+safe(r.location_name||r.nearest_city||'')+'<br>Input: '+safe(r.input_frequency??'—')+' MHz · Tone: '+safe(r.tone||'—')+'<br>'+safe(r.band||'')+' · '+safe(r.mode||'')+'<br>Status: '+safe(status)+'<br>'+safe(r.club_affiliate||'')+(r.needs_review?'<br>Coordinates need review':'')+'<br><a href="https://ara.radio/repeaters" target="_blank" rel="noopener noreferrer">ARA repeater directory</a>');
        marker.bindTooltip(title,{className:'ham-tip'});
        repeatersLayer.addLayer(marker);mapped++;
      }
      rowStatus('repeaters',mapped+' mapped'+(data.repeaters.length>mapped?' / '+data.repeaters.length:'') ,'ok');
    }catch{rowStatus('repeaters','feed offline','warn');}
  }
  const repeaterButton=layerButton('repeaters');
  if(repeaterButton){
    repeaterButton.disabled=false;repeaterButton.removeAttribute('aria-disabled');
    repeaterButton.closest('.toggle-row')?.style.removeProperty('opacity');
    repeaterButton.addEventListener('click',()=>setTimeout(()=>{if(enabled('repeaters'))loadRepeaters();},0));
    loadRepeaters();
    setInterval(()=>{if(enabled('repeaters'))loadRepeaters();},300000);
  }
  radioMap.on('moveend zoomend',()=>{if(enabled('states'))loadBoundaries('states');if(enabled('counties'))loadBoundaries('counties')});
  layerButton('states').addEventListener('click',()=>setTimeout(()=>enabled('states')&&loadBoundaries('states'),0));
  layerButton('counties').addEventListener('click',()=>setTimeout(()=>enabled('counties')&&loadBoundaries('counties'),0));
  $('weatherArea').addEventListener('change',loadWeather);
  document.querySelectorAll('#layersPanel [data-layer]').forEach(button=>button.addEventListener('click',()=>setTimeout(updateCounters,0)));
  document.querySelectorAll('[data-source-select]').forEach(select=>select.addEventListener('change',updateSourceFields));
  $('testDataSources').addEventListener('click',testDataSources);
  window.addEventListener('hammap-settings-loaded',()=>{updateSourceFields();loadConfiguredFeeds();});
  window.addEventListener('hammap-settings-saved',()=>{updateSourceFields();loadConfiguredFeeds();});
  $('allstarNode')?.addEventListener('input',()=>{if($('allstarNode').value.replace(/\D/g,'')&&$('allstarProvider')?.value==='disabled')$('allstarProvider').value='official';updateSourceFields();});
  $('allstarProvider')?.addEventListener('change',()=>{updateSourceFields();});
  document.querySelectorAll('.digital-filter').forEach(button=>{
    button.addEventListener('click',()=>{
      document.querySelectorAll('.digital-filter').forEach(other=>other.classList.toggle('on',other===button));
      renderPsk();
    });
  });
  loadLocal();
  for (const name of ['dlayer','zones']) layerButton(name)?.classList.remove('on');
  updateSourceFields();
  loadPsk();
  $('callsign')?.addEventListener('change',loadPsk);
  layerButton('dx')?.addEventListener('click',()=>setTimeout(renderPsk,0));
  rowStatus('paths','use path tool');rowStatus('grid','20° × 10°');updateCounters();
  loadBoundaries('states'); loadPortable(); loadWeather(); loadSolar();loadConfiguredFeeds();loadSatellites();
  setInterval(()=>{loadPortable();loadWeather();loadSolar();loadConfiguredFeeds();loadPsk()},5*60*1000);
})();
