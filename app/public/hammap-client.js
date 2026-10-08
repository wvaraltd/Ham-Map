(() => {
  const state = { authenticated: false, setupRequired: false, callsign: null };
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  async function api(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
    const type = response.headers.get('content-type') || '';
    const result = type.includes('json') ? await response.json() : await response.text();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  }
  function injectUi() {
    const style = document.createElement('style');
    style.textContent = `.account-modal{position:fixed;inset:0;background:#000b;z-index:60;display:none;place-items:center;padding:16px}.account-modal.open{display:grid}.account-sheet{width:min(430px,100%);background:#091720;border:1px solid #31505c;border-radius:14px;padding:20px;box-shadow:0 16px 50px #000b}.account-sheet h2{margin:0 0 5px}.account-sheet p{color:#86a2aa;font-size:.78rem;line-height:1.5}.account-error{color:#ff8585;min-height:1.3em;font-size:.75rem}.account-actions{display:flex;gap:8px}.account-actions button{flex:1}.sync-chip{font-size:.67rem;color:#86a2aa}`;
    document.head.appendChild(style);
    const account = document.createElement('button'); account.className = 'pillbtn'; account.id = 'accountBtn'; account.innerHTML = '♙ <span>Account</span>';
    document.querySelector('.top').insertBefore(account, $('layersBtn'));
    const modal = document.createElement('div'); modal.className = 'account-modal'; modal.id = 'accountModal'; modal.innerHTML = `<div class="account-sheet"><div class="drawer-head"><div><h2 id="accountTitle">Operator login</h2><small class="sync-chip" id="accountStatus">Checking server…</small></div><button class="close" id="closeAccount">×</button></div><p id="accountHelp">Sign in to synchronize this single-operator logbook.</p><div class="field"><label>Station callsign</label><input id="accountCall" autocomplete="username"></div><div class="field"><label>Password</label><input id="accountPassword" type="password" autocomplete="current-password"></div><div class="account-error" id="accountError"></div><div class="account-actions"><button class="save" id="accountSubmit">Sign in</button><button class="test" id="accountLogout" style="display:none;margin:0">Sign out</button></div></div>`;
    document.body.appendChild(modal);
    const adif = document.createElement('button'); adif.className = 'test'; adif.id = 'exportAdif'; adif.textContent = 'Export synchronized ADIF';
    $('logRows').closest('table').after(adif); adif.onclick = () => { if (!state.authenticated) return openAccount(); window.location.href = '/api/qsos/adif'; };
    account.onclick = openAccount; $('closeAccount').onclick = () => modal.classList.remove('open'); $('accountSubmit').onclick = submitAccount; $('accountLogout').onclick = logout;
  }
  async function refreshSession() {
    try {
      Object.assign(state, await api('/api/auth/session', { method: 'GET', headers: {} }));
      updateAccountUi();
      if (state.authenticated) await syncSettingsFromServer();
    } catch (error) { $('accountStatus').textContent = 'Backend unavailable'; }
  }
  function updateAccountUi() {
    const btn = $('accountBtn');
    for (const id of ['logBtn','quickLogBtn']) {
      const control=$(id);
      if(control){control.title=state.authenticated?'Log a QSO':'Sign in to log a QSO';control.setAttribute('aria-label',control.title);}
    }
    btn.innerHTML = state.authenticated ? `● <span>${escapeHtml(state.callsign)}</span>` : '♙ <span>Account</span>';
    $('accountTitle').textContent = state.authenticated ? 'Operator account' : state.setupRequired ? 'Create operator account' : 'Operator login';
    $('accountStatus').textContent = state.authenticated ? `Cloud log synchronized • ${state.callsign}` : state.setupRequired ? 'First-run setup' : 'Sign in to synchronize';
    $('accountHelp').textContent = state.authenticated ? 'This is the only operator account for this Ham Map installation.' : state.setupRequired ? 'Create the private account used to reach your logbook from any authorized device.' : 'Sign in to your private Ham Map logbook.';
    $('accountSubmit').style.display = state.authenticated ? 'none' : '';
    $('accountLogout').style.display = state.authenticated ? '' : 'none';
    $('accountCall').value = state.callsign || $('callsign')?.value || '';
    $('accountCall').disabled = state.authenticated;
    $('accountPassword').parentElement.style.display = state.authenticated ? 'none' : '';
    $('accountSubmit').textContent = state.setupRequired ? 'Create account' : 'Sign in';
  }
  function openAccount() { updateAccountUi(); $('accountError').textContent = ''; $('accountModal').classList.add('open'); }
  async function submitAccount() {
    $('accountError').textContent = '';
    try {
      const result = await api(state.setupRequired ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ callsign: $('accountCall').value, password: $('accountPassword').value }) });
      Object.assign(state, result, { setupRequired: false }); $('callsign').value = state.callsign; $('accountPassword').value = ''; updateAccountUi(); applyStation(); $('accountModal').classList.remove('open'); toast(`Signed in as ${state.callsign}`); await syncSettingsToServer(); await renderRemoteLog();
    } catch (error) { $('accountError').textContent = error.message; }
  }
  async function logout() { await api('/api/auth/logout', { method: 'POST', body: '{}' }); Object.assign(state, { authenticated: false, callsign: null }); $('logModal').classList.remove('open'); $('logModal').setAttribute('aria-hidden','true'); updateAccountUi(); $('accountModal').classList.remove('open'); toast('Signed out'); }
  function feedSources() { const value=id=>$(id)?.value||''; return {pota:{provider:value('potaProvider')},solar:{provider:value('solarProvider')},nws:{provider:value('nwsProvider')},boundaries:{provider:value('boundaryProvider')},sota:{provider:value('sotaProvider'),url:value('sotaUrl')},dx:{provider:value('dxProvider'),url:value('dxUrl')},iss:{provider:value('issProvider'),url:value('issUrl')},allstar:{provider:value('allstarProvider'),url:value('allstarUrl'),node:value('allstarNode')},mesh:{provider:value('meshProvider'),url:value('meshUrl')}}; }
  function stationSettings() { return { callsign: $('callsign').value.toUpperCase(), grid: $('grid').value.toUpperCase(), location: $('location').value, latitude: Number($('latitude').value), longitude: Number($('longitude').value), weatherArea: $('weatherArea').value, operationMode: $('operationMode').value, potaRef: $('potaRef').value.toUpperCase(), sotaRef: $('sotaRef').value.toUpperCase(), portableGrid: $('portableGrid').value.toUpperCase(), activationName: $('activationName').value, feedSources:feedSources() }; }
  async function syncSettingsToServer() { if (!state.authenticated) return; await api('/api/settings', { method: 'PUT', body: JSON.stringify(stationSettings()) }); }
  async function syncSettingsFromServer() {
    const data = await api('/api/settings', { method: 'GET', headers: {} });
    for (const [key,id] of Object.entries({callsign:'callsign',grid:'grid',location:'location',latitude:'latitude',longitude:'longitude',weatherArea:'weatherArea',operationMode:'operationMode',potaRef:'potaRef',sotaRef:'sotaRef',portableGrid:'portableGrid',activationName:'activationName'})) if (data[key] !== undefined && data[key] !== null && $(id)) $(id).value = data[key];
    for (const [key,source] of Object.entries(data.feedSources||{})) { if($(`${key}Provider`)&&source.provider)$(`${key}Provider`).value=source.provider;if($(`${key}Url`)&&source.url)$(`${key}Url`).value=source.url;if(key==='allstar'&&source.node)$('allstarNode').value=source.node; }
    window.dispatchEvent(new Event('hammap-settings-loaded'));
    applyStation();
  }
  async function saveRemoteQso() {
    if (!state.authenticated) { openAccount(); return; }
    const call = $('qsoCall').value.trim().toUpperCase();
    const activation = JSON.parse(localStorage.getItem('hammap-activation') || 'null');
    const attach = $('attachActivation').classList.contains('on') && activation?.active;
    const payload = { call, time: `${$('qsoTime').value}Z`, freq: $('qsoFreq').value, band: bandFor($('qsoFreq').value), mode: $('qsoMode').value, sent: $('qsoSent').value, received: $('qsoReceived').value, grid: (attach && activation.grid) || $('grid').value, operationMode: attach ? activation.mode : 'home', potaRef: attach ? activation.potaRef : '', sotaRef: attach ? activation.sotaRef : '', activationName: attach ? activation.name : '', notes: $('qsoNotes').value };
    try { await api('/api/qsos', { method: 'POST', body: JSON.stringify(payload) }); $('qsoCall').value = ''; $('qsoNotes').value = ''; await renderRemoteLog(); toast(`QSO with ${call} synchronized`); }
    catch (error) { toast(error.message); }
  }
  async function renderRemoteLog() {
    if (!state.authenticated) return;
    const { qsos } = await api('/api/qsos?limit=5', { method: 'GET', headers: {} });
    $('logRows').innerHTML = qsos.length ? qsos.map(q => `<tr><td>${escapeHtml(new Date(q.qso_time).toISOString().slice(5,16).replace('T',' '))}</td><td><strong>${escapeHtml(q.contact_callsign)}</strong></td><td>${escapeHtml(q.band || '')} ${escapeHtml(q.mode)}</td><td>${escapeHtml([q.pota_reference&&`POTA ${q.pota_reference}`,q.sota_reference&&`SOTA ${q.sota_reference}`].filter(Boolean).join(' + ') || '—')}</td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--muted)">No synchronized contacts yet.</td></tr>';
  }
  injectUi();
  const originalSave = $('saveSettings').onclick; $('saveSettings').onclick = async () => { originalSave?.(); try { await syncSettingsToServer(); window.dispatchEvent(new Event('hammap-settings-saved')); } catch (error) { toast(`Settings not synchronized: ${error.message}`); } };
  $('saveQso').onclick = saveRemoteQso;
  $('testPush').onclick = async () => { if (!state.authenticated) return openAccount(); try { await api('/api/notifications/pushover/test', { method: 'POST', body: JSON.stringify({ userKey: $('pushoverUserKey').value, appToken: $('pushoverAppToken').value }) }); toast('Pushover test sent'); } catch (error) { toast(error.message); } };
  // The public map is read-only. Never open the logging form without a valid session.
  async function guardedOpenLog() {
    try {
      const session=await api('/api/auth/session',{method:'GET',headers:{}});
      Object.assign(state,session);
      updateAccountUi();
      if (!state.authenticated) { openAccount(); return; }
      $('qsoTime').value=new Date().toISOString().slice(0,16);
      $('logModal').classList.add('open');
      $('logModal').setAttribute('aria-hidden','false');
      await renderRemoteLog();
      $('qsoCall').focus();
    } catch(error) { toast('Unable to verify login'); }
  }
  $('logBtn').onclick=guardedOpenLog;
  $('quickLogBtn').onclick=guardedOpenLog;
  refreshSession();
})();
