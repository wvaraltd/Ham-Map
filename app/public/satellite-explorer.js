(()=>{
'use strict';
const $=id=>document.getElementById(id);
const defaults=[{norad:25544,name:'ISS'},{norad:27607,name:'SO-50'},{norad:44909,name:'RS-44'}];
let catalog=[],selected=[],prefs={},loading=false;
try{prefs=JSON.parse(localStorage.getItem('hammap-satellites')||'null')||{};}catch{}
if(Array.isArray(prefs.satellites))selected=prefs.satellites.filter(x=>Number.isSafeInteger(x.norad)&&x.norad>0&&x.norad<=999999&&typeof x.name==='string').slice(0,20);
else if(Array.isArray(prefs.ids))selected=prefs.ids.map(id=>defaults.find(x=>x.norad===Number(id)||x.name===id)).filter(Boolean);
else selected=defaults.map(x=>({...x}));
function save(){prefs={...prefs,ids:selected.map(x=>x.norad),satellites:selected.map(x=>({...x}))};localStorage.setItem('hammap-satellites',JSON.stringify(prefs));$('selectedCount').textContent=selected.length+' / 20 selected';}
function status(message){$('status').textContent=message;}
function render(){
const term=$('search').value.trim().toLowerCase(),category=$('category').value;
const matches=catalog.filter(x=>(category==='all'||category==='selected'&&selected.some(s=>s.norad===x.norad)||x.categories.includes(category))&&(!term||x.name.toLowerCase().includes(term)||String(x.norad).includes(term)));
const list=$('results');list.replaceChildren();
for(const sat of matches.slice(0,300)){
const row=document.createElement('label');row.className='sat';
const box=document.createElement('input');box.type='checkbox';box.checked=selected.some(x=>x.norad===sat.norad);box.setAttribute('aria-label','Track '+sat.name);
const info=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');
name.textContent=sat.name;detail.textContent='NORAD '+sat.norad+' • '+sat.categories.join(' / ');
info.append(name,detail);row.append(box,info);
box.addEventListener('change',()=>{
if(box.checked){if(selected.length>=20){box.checked=false;status('Limit reached: remove a satellite before adding another.');return;}selected.push({norad:sat.norad,name:sat.name});}
else selected=selected.filter(x=>x.norad!==sat.norad);
save();if(category==='selected')render();else status('Saved. Return to HamMap to see updated satellite tracking.');
});
list.append(row);
}
status(matches.length+' matching satellites'+(matches.length>300?' • showing first 300; refine your search':'')+'. '+selected.length+' selected.');
save();
}
async function load(){
if(loading)return;loading=true;$('refresh').disabled=true;status('Loading CelesTrak satellite catalog…');
try{const response=await fetch('/api/live/satellite/catalog',{headers:{accept:'application/json'}});const data=await response.json();if(!response.ok||!Array.isArray(data.satellites))throw new Error(data.error||'Catalog unavailable');
catalog=data.satellites;for(const sat of selected)if(!catalog.some(x=>x.norad===sat.norad))catalog.push({...sat,categories:['selected']});
catalog.sort((a,b)=>a.name.localeCompare(b.name));render();
}catch(e){status('Catalog unavailable: '+e.message+'. Previously selected satellites remain saved.');}
finally{loading=false;$('refresh').disabled=false;}
}
$('search').addEventListener('input',render);$('category').addEventListener('change',render);$('refresh').addEventListener('click',load);
save();load();
})();