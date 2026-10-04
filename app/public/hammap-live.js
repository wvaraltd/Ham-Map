(() => {
  const $ = id => document.getElementById(id);
  const layerButton = name => document.querySelector(`[data-layer="${name}"]`);
  const enabled = name => layerButton(name)?.classList.contains('on');
  const safe = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const station = { lat: Number($('latitude')?.value) || 37.77687, lon: Number($('longitude')?.value) || -81.202516 };
  let selectedBand = '20m';
  let measureArmed = false;
  let pathLine = null;
  let liveSuccesses = 0;
  let liveFailures = 0;

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
  function drawGrid() {
    gridMapLayer.clearLayers();
    for (let lon=-180; lon<=180; lon+=20) gridMapLayer.addLayer(L.polyline([[-90,lon],[90,lon]],{color:'#62a6b7',weight:.6,opacity:.42,interactive:false}));
    for (let lat=-80; lat<=80; lat+=10) gridMapLayer.addLayer(L.polyline([[lat,-180],[lat,180]],{color:'#62a6b7',weight:.6,opacity:.42,interactive:false}));
  }
  drawGrid();

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
  function renderPortable(layer, spots, kind) {
    layer.clearLayers();
    const normalized=spots.map(x=>normalizeSpot(x,kind)).filter(Boolean).filter(x=>!selectedBand || !x.band || x.band===selectedBand);
    for (const spot of normalized) {
      layer.addLayer(L.marker([spot.lat,spot.lon],{icon:portableIcon(kind)}).bindTooltip(`${safe(spot.call)} • ${kind.toUpperCase()} ${safe(spot.ref)} • ${safe(spot.freq)} ${safe(spot.mode)}`,{className:'ham-tip'}));
    }
    return normalized;
  }
  async function loadPortable() {
    const all=[];
    for (const [kind,layer] of [['pota',potaLayer],['sota',sotaLayer]]) {
      try { const data = await getJson(`/api/live/${kind}`); const spots=renderPortable(layer, data.spots || data, kind);all.push(...spots);rowStatus(kind,`${spots.length} spots`,'ok');setFeedState(true, `${kind.toUpperCase()} updated`); }
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
  function updateSourceFields() {
    document.querySelectorAll('[data-source-url]').forEach(field=>{const name=field.dataset.sourceUrl,select=$(`${name}Provider`);field.hidden=select?.value!=='custom';});
    for(const [sourceName,layerName] of [['sota','sota'],['dx','dx'],['iss','satellite'],['allstar','allstar'],['mesh','meshcore']]){const button=layerButton(layerName),configured=$(`${sourceName}Provider`)?.value!=='disabled';if(button){button.disabled=!configured;button.setAttribute('aria-disabled',String(!configured));if(!configured)setLayer(layerName,false);}const row=button?.closest('.toggle-row');if(row){row.style.opacity=configured?'1':'.55';rowStatus(layerName,configured?'ready':'not set',configured?'ok':'');}}
    const node=String($('allstarNode')?.value||'').replace(/\D/g,'').slice(0,8)||'—';$('allstarNodeRing').textContent=node;$('allstarTitle').textContent=node==='—'?'AllStar node':`AllStar node ${node}`;
    if($('allstarProvider')?.value==='disabled'){$('allstarCard').querySelector('.status').textContent='NOT CONFIGURED';$('allstarDetail').textContent='Choose AllStarLink Stats or a custom JSON source in Settings.';}
    updateCounters();
  }
  async function testDataSources() {
    const button=$('testDataSources');button.disabled=true;button.textContent='Testing…';
    try{const response=await fetch('/api/feeds/test',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({feedSources:currentFeedSources()})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Test failed');const failed=Object.entries(data.results).filter(([,result])=>!result.ok);toast(failed.length?`${failed.map(([name])=>name.toUpperCase()).join(', ')} failed; check URLs`:'Configured sources passed');}
    catch(error){toast(error.message);}finally{button.disabled=false;button.textContent='Test configured sources';}
  }
  async function loadConfiguredFeeds(){
    if($('dxProvider')?.value!=='disabled')try{const data=await getJson('/api/live/dx'),spots=Array.isArray(data)?data:(data.spots||[]);dxLayer.clearLayers();for(const raw of spots){const spot=normalizeSpot(raw,'dx');if(spot&&(!selectedBand||!spot.band||spot.band===selectedBand))dxLayer.addLayer(L.marker([spot.lat,spot.lon],{icon:icon('dx-dot')}).bindTooltip(`${safe(spot.call)} • ${safe(spot.freq)} ${safe(spot.mode)}`,{className:'ham-tip'}));}rowStatus('dx',`${dxLayer.getLayers().length} spots`,'ok');}catch{dxLayer.clearLayers();rowStatus('dx','offline','warn');}
    if($('issProvider')?.value!=='disabled')try{const data=await getJson('/api/live/iss');const lat=Number(data.latitude??data.lat),lon=Number(data.longitude??data.lon??data.lng);satelliteLayer.clearLayers();if(Number.isFinite(lat)&&Number.isFinite(lon))satelliteLayer.addLayer(L.marker([lat,lon],{icon:icon('iss-dot')}).bindTooltip('ISS live position',{permanent:true,className:'ham-tip'}));$('issCard').querySelector('.status').textContent='LIVE';rowStatus('satellite','live','ok');}catch{$('issCard').querySelector('.status').textContent='OFFLINE';rowStatus('satellite','offline','warn');}
    if($('allstarProvider')?.value!=='disabled')try{const data=await getJson('/api/live/allstar'),node=String(data.node||$('allstarNode').value);$('allstarNodeRing').textContent=node;$('allstarTitle').textContent=`AllStar node ${node}`;$('allstarCard').querySelector('.status').textContent=data.online?'ONLINE':'OFFLINE';$('allstarDetail').textContent=`Node ${node} • ${data.source||'configured source'}`;rowStatus('allstar',data.online?'online':'offline',data.online?'ok':'warn');}catch(error){const node=String($('allstarNode').value||'—');$('allstarNodeRing').textContent=node;$('allstarTitle').textContent=`AllStar node ${node}`;$('allstarCard').querySelector('.status').textContent='OFFLINE';$('allstarDetail').textContent='The configured AllStar source could not be reached.';rowStatus('allstar','offline','warn');}
    if($('meshProvider')?.value!=='disabled')try{const data=await getJson('/api/live/mesh'),nodes=Array.isArray(data)?data:(data.nodes||[]);meshcoreLayer.clearLayers();for(const node of nodes){const lat=Number(node.latitude??node.lat),lon=Number(node.longitude??node.lon??node.lng);if(Number.isFinite(lat)&&Number.isFinite(lon))meshcoreLayer.addLayer(L.marker([lat,lon],{icon:icon('mesh-dot')}).bindTooltip(safe(node.name||node.id||'Mesh node'),{className:'ham-tip'}));}rowStatus('meshcore',`${meshcoreLayer.getLayers().length} nodes`,'ok');}catch{meshcoreLayer.clearLayers();rowStatus('meshcore','offline','warn');}
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
    document.querySelectorAll('.band').forEach(x=>x.classList.remove('active')); b.classList.add('active'); selectedBand=b.querySelector('strong').textContent; $('bandContext').textContent=`${selectedBand} • live spots`; loadPortable();
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

  for (const name of ['dlayer','aurora','zones','repeaters','labels']) {
    const button=layerButton(name), row=button?.closest('.toggle-row');
    if(button){button.classList.remove('on');button.disabled=true;button.setAttribute('aria-disabled','true');}
    if(row){row.title='A live data source is not configured';row.style.opacity='.55';rowStatus(name,'not set');}
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
  $('allstarNode').addEventListener('input',()=>{if($('allstarNode').value.replace(/\D/g,'')&&$('allstarProvider').value==='disabled')$('allstarProvider').value='official';updateSourceFields();});
  $('allstarProvider').addEventListener('change',()=>{updateSourceFields();});
  loadLocal();
  for (const name of ['dlayer','aurora','zones','repeaters','labels']) layerButton(name)?.classList.remove('on');
  updateSourceFields();
  rowStatus('paths','use path tool');rowStatus('grid','20° × 10°');updateCounters();
  loadBoundaries('states'); loadPortable(); loadWeather(); loadSolar();loadConfiguredFeeds();
  setInterval(()=>{loadPortable();loadWeather();loadSolar();loadConfiguredFeeds()},5*60*1000);
})();
