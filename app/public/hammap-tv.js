(()=>{
'use strict';
const tv=new URLSearchParams(location.search).get('tv')==='1';
const link=new URL(location.href);link.searchParams.set('tv','1');link.hash='';
const open=document.getElementById('tvBtn'),copy=document.getElementById('tvCopyBtn');
open?.addEventListener('click',()=>{const win=window.open(link.href,'hammap-tv','popup=yes,width=1600,height=900');if(!win)alert('Allow pop-ups to open the TV map, or use the copy-link button.');});
copy?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(link.href);copy.title='TV map link copied';}catch{window.prompt('Copy TV map link:',link.href);}});
const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('hammap-tv-display'):null;
function snapshot(){
return {layers:[...document.querySelectorAll('#layersPanel [data-layer]')].filter(b=>b.classList.contains('on')).map(b=>b.dataset.layer),center:[radioMap.getCenter().lat,radioMap.getCenter().lng],zoom:radioMap.getZoom(),satellites:localStorage.getItem('hammap-satellites'),station:localStorage.getItem('hammap'),timestamp:Date.now()};
}
if(tv){
document.body.classList.add('tv-mode');
document.title='WV8T HamMap • TV Display';
const overlay=document.createElement('div');overlay.className='tv-overlay';
const title=document.createElement('strong');title.textContent='WV8T HAMMAP';
const time=document.createElement('span');time.className='tv-time';
const state=document.createElement('span');state.textContent='MAP DISPLAY';
overlay.append(title,time,state);document.body.append(overlay);
const controls=document.createElement('div');controls.className='tv-help';
const fullscreen=document.createElement('button');fullscreen.type='button';fullscreen.textContent='⛶ Fullscreen';fullscreen.title='Enter or exit fullscreen (F)';
const home=document.createElement('button');home.type='button';home.textContent='⌖ World';home.title='Fit world map';
fullscreen.addEventListener('click',()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});else document.exitFullscreen?.();});
home.addEventListener('click',()=>radioMap.setView([20,0],Math.max(2,radioMap.getMinZoom()),{animate:false}));
const rotate=document.createElement('button');rotate.type='button';rotate.title='Cycle through TV display profiles every 30 seconds';
const profiles=[
{name:'WORLD',center:[20,0],zoom:2,layers:['night','gray','satellite','aurora']},
{name:'DX / HF',center:[20,0],zoom:2,layers:['night','gray','dx','labels','paths']},
{name:'WEATHER',center:[20,0],zoom:2,layers:['night','weather','radar','earthquakes']},
{name:'SATELLITES',center:[20,0],zoom:2,layers:['night','satellite']}
];
let rotating=localStorage.getItem('hammap-tv-rotation')==='1',profileIndex=0;
const applyProfile=()=>{
const p=profiles[profileIndex++%profiles.length];
for(const b of document.querySelectorAll('#layersPanel [data-layer]')){
if(!['night','gray','satellite','aurora','dx','labels','paths','weather','radar','earthquakes'].includes(b.dataset.layer))continue;
const wanted=p.layers.includes(b.dataset.layer);
if(!b.disabled&&b.classList.contains('on')!==wanted)b.click();
}
radioMap.setView(p.center,p.zoom,{animate:false});state.textContent=p.name+' PROFILE';
};
const updateRotate=()=>{rotate.textContent=rotating?'⏸ Stop rotation':'▶ Rotate views';localStorage.setItem('hammap-tv-rotation',rotating?'1':'0');};
rotate.addEventListener('click',()=>{rotating=!rotating;updateRotate();if(rotating)applyProfile();});
updateRotate();
controls.append(fullscreen,home,rotate);document.body.append(controls);
setInterval(()=>{if(rotating)applyProfile();},30000);
if(rotating)setTimeout(applyProfile,2000);

setTimeout(()=>controls.classList.add('auto-hide'),12000);
document.addEventListener('fullscreenchange',()=>{fullscreen.textContent=document.fullscreenElement?'⛶ Exit fullscreen':'⛶ Fullscreen';setTimeout(()=>radioMap.invalidateSize(),100);});

setInterval(()=>{time.textContent=new Date().toLocaleTimeString('en-GB',{timeZone:'UTC',hour12:false})+' UTC';},1000);
const sync=message=>{
if(rotating||!message||!Array.isArray(message.layers)||!Array.isArray(message.center))return;
for(const b of document.querySelectorAll('#layersPanel [data-layer]')){
const wanted=message.layers.includes(b.dataset.layer);
if(b.classList.contains('on')!==wanted&&!b.disabled)b.click();
}
if(message.satellites&&localStorage.getItem('hammap-satellites')!==message.satellites){
localStorage.setItem('hammap-satellites',message.satellites);
window.dispatchEvent(new Event('focus'));
}
if(message.station&&localStorage.getItem('hammap')!==message.station){
localStorage.setItem('hammap',message.station);
}
if(Number.isFinite(message.center[0])&&Number.isFinite(message.center[1])&&Number.isFinite(message.zoom)){
const c=radioMap.getCenter();if(Math.abs(c.lat-message.center[0])>.001||Math.abs(c.lng-message.center[1])>.001||radioMap.getZoom()!==message.zoom)radioMap.setView(message.center,message.zoom,{animate:false});
}
state.textContent='SYNCED WITH DASHBOARD';
};
channel?.addEventListener('message',event=>{if(event.data?.type==='state')sync(event.data.state);});
window.addEventListener('storage',event=>{if(event.key==='hammap-tv-state')try{sync(JSON.parse(event.newValue));}catch{}});
try{sync(JSON.parse(localStorage.getItem('hammap-tv-state')));}catch{}
setTimeout(()=>radioMap.invalidateSize(),250);
setTimeout(()=>radioMap.invalidateSize(),1200);
const resizeObserver=typeof ResizeObserver!=='undefined'?new ResizeObserver(()=>radioMap.invalidateSize()):null;
resizeObserver?.observe(document.getElementById('leafletMap'));

window.addEventListener('resize',()=>radioMap.invalidateSize());
window.addEventListener('keydown',event=>{if(event.key==='f'||event.key==='F'){if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});else document.exitFullscreen?.();}});
}else{
let last='';
function publish(){
const state=snapshot(),serialized=JSON.stringify({...state,timestamp:0});
if(serialized===last)return;last=serialized;
localStorage.setItem('hammap-tv-state',JSON.stringify(state));
channel?.postMessage({type:'state',state});
}
setInterval(publish,1500);setTimeout(publish,1500);
}
})();