(() => {
  const card=document.getElementById('csnCard'),button=document.getElementById('csnBtn');
  const status=document.getElementById('csnStatus'),details=document.getElementById('csnDetails');
  const trackToggle=document.getElementById('csnGroundTrack');
  const layer=L.layerGroup().addTo(radioMap);
  let open=false, lastTrack=0, lastGround=0, busy=false;
  const fmt=(n,d=1)=>Number.isFinite(Number(n))?Number(n).toFixed(d):'—';
  const cell=(label,value)=>'<div><small>'+label+'</small><strong>'+value+'</strong></div>';
  function clear(){layer.clearLayers();}
  async function update(){
    if(!open||busy)return;
    busy=true;
    try{
      const r=await fetch('/api/csn/track',{cache:'no-store'});
      if(!r.ok)throw Error('Controller offline');
      const d=await r.json();lastTrack=Date.now();
      const age=Math.abs(Date.now()/1000-Number(d.time));
      status.textContent=(d.mode===1?'● Tracking':'○ Idle')+' · '+(age>90?'Telemetry time differs from server':'Live LAN telemetry');
      const antValid=Number(d.az)>=0&&Number(d.az)<=450&&Number(d.el)>=0&&Number(d.el)<=180&&Number(d.az)!==450&&Number(d.el)!==180;
      details.innerHTML=cell('Satellite',String(d.satName||('NORAD '+(d.catno||'—'))).replace(/[<>&]/g,''))+
       cell('Satellite AZ / EL',fmt(d.satAZ)+'° / '+fmt(d.satEL)+'°')+
       cell('Antenna AZ / EL',antValid?fmt(d.az)+'° / '+fmt(d.el)+'°':'Unavailable')+
       cell('Next AOS',Number(d.ttaos)>0?Math.floor(d.ttaos/3600)+'h '+Math.floor(d.ttaos%3600/60)+'m':'—')+
       cell('Maximum EL',fmt(d.maxEL)+'°')+cell('Range',fmt(d.rng,0)+' km');
      if(trackToggle.checked&&Date.now()-lastGround>20000){
        const g=await fetch('/api/csn/gtrack',{cache:'no-store'});
        if(g.ok){const j=await g.json();clear();const pts=j.points||[];
          let segment=[],prev=null;
          const flush=()=>{if(segment.length>1)L.polyline(segment,{color:'#ffb84e',weight:2,opacity:.9,dashArray:'7 5',interactive:false}).addTo(layer);segment=[];};
          for(const p of pts){if(!Number.isFinite(p.lat)||!Number.isFinite(p.lon))continue;if(prev!==null&&Math.abs(p.lon-prev)>180)flush();segment.push([p.lat,p.lon]);prev=p.lon;}flush();
        }
        lastGround=Date.now();
      }
    }catch(e){status.textContent='● Controller unavailable';details.textContent='Waiting for LAN telemetry';}
    finally{busy=false;}
  }
  button.onclick=()=>{open=!open;card.hidden=!open;if(open){lastGround=0;update();}else clear();};
  document.getElementById('csnClose').onclick=()=>{open=false;card.hidden=true;clear();};
  trackToggle.onchange=()=>{clear();lastGround=0;if(open)update();};
  setInterval(update,5000);
})();