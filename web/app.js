const $ = id => document.getElementById(id);
const zone = 'America/Lima';
function format(seconds, options){
  const formatter=new Intl.DateTimeFormat('es-PE',{timeZone:zone,hourCycle:'h12',...options});
  return formatter.formatToParts(seconds*1000).map(part=>
    part.type==='dayPeriod' ? part.value.replace(/[^apm]/gi,'').toUpperCase() : part.value
  ).join('');
}
const stamp = seconds => format(seconds,{dateStyle:'short',timeStyle:'short'});
const intervalText = (start,end) => 'Entrada '+stamp(start)+' · Salida '+stamp(end);
function remainingTime(seconds){
  const minutes=Math.ceil(seconds/60);
  const hours=Math.floor(minutes/60);
  return hours ? hours+' h '+minutes%60+' min' : minutes+' min';
}
let state, page='board', selected, generation=0;
let pendingEnds=new Map();
let acknowledged=new Set();
function saveAlerts(){
  try{
    localStorage.setItem('avisos-salida:'+state.name,JSON.stringify({seenAt:state.now,pending:[...pendingEnds.keys()],ack:[...acknowledged]}));
  }catch{}
}
function alertControls(){
  const supported=window.isSecureContext && 'Notification' in window;
  $('enableAlerts').hidden=!supported || Notification.permission!=='default';
  $('alertStatus').textContent=!supported?'Avisos en pantalla':Notification.permission==='granted'?'Notificaciones activas':Notification.permission==='denied'?'Avisos en pantalla · permiso bloqueado':'';
}
$('enableAlerts').onclick=async()=>{
  try{await Notification.requestPermission();alertControls();}
  catch{$('alertStatus').textContent='Avisos disponibles en pantalla';}
};
async function notifyEnd(stay,system=true){
  if(pendingEnds.has(stay.id))return;
  pendingEnds.set(stay.id,stay);
  const message='Habitación '+stay.room+' · Hora cumplida · '+intervalText(stay.start,stay.end);
  const row=document.createElement('div');
  const dismiss=document.createElement('button');
  row.dataset.stayId=String(stay.id);
  dismiss.textContent='Hora concluida';
  dismiss.onclick=()=>completeStay(stay.id,dismiss);
  row.append(message,dismiss);
  $('expired').prepend(row);
  if(!system || !('Notification' in window) || Notification.permission!=='granted')return;
  const options={body:message,tag:'estancia-'+stay.id,icon:'/icon-192.png'};
  try{
    const title='Habitación '+stay.room+' · Hora cumplida';
    const registration=await navigator.serviceWorker?.getRegistration();
    if(registration?.active)await registration.showNotification(title,options);
    else new Notification(title,options);
  }catch{$('alertStatus').textContent='Avisos disponibles en pantalla';}
}
async function completeStay(id,button){
  button.disabled=true;
  $('completeError').textContent='';
  try{
    await request('complete',{id});
    pendingEnds.delete(id);
    acknowledged.add(id);
    document.querySelectorAll('[data-stay-id]').forEach(row=>{
      if(row.dataset.stayId===String(id))row.remove();
    });
    saveAlerts();
    await refresh();
  }catch(error){$('completeError').textContent=error.message;$('alertStatus').textContent=error.message;}
  finally{button.disabled=false;}
}
$('completeStay').onclick=()=>completeStay(Number($('completeStay').dataset.id),$('completeStay'));
async function request(path, payload) {
  const res = await fetch('/api/'+path, payload ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)} : {});
  const data = await res.json();
  if (!res.ok) {
    if (res.status===401) showLogin();
    throw new Error(data.error || 'No se pudo completar la operación.');
  }
  return data;
}
function showLogin(){
  generation++;
  state=null;
  pendingEnds.clear();
  $('expired').replaceChildren();
  $('modal').close();
  $('app').hidden=true;
  $('login').hidden=false;
}
function active(room){
  return state.stays.find(s=>!s.withdrawn_at && s.room===room && s.start<=state.now && s.end>state.now);
}
const historyFilter={day:'',hour:null};
function matchesHistory(stay){
  const [day,time]=limaFields(stay.start);
  return (!historyFilter.day || day===historyFilter.day) &&
    (historyFilter.hour===null || Number(time.slice(0,2))===historyFilter.hour);
}
function historyControls(content){
  if($('historyFilters'))return;
  content.innerHTML='<section id="historyFilters"><b>Buscar por entrada</b><div class="filter-buttons"><button type="button" data-history="all">Todas las fechas</button><button type="button" data-history="today">Hoy</button><button type="button" data-history="yesterday">Ayer</button></div><div class="filter-buttons"><button type="button" data-history="previous">← Día anterior</button><label>Fecha<input type="date" id="historyDay"></label><button type="button" data-history="next">Día siguiente →</button></div><div class="filter-buttons"><button type="button" data-history="anyHour">Cualquier hora</button><button type="button" data-history="hourBack">−1 hora</button><output id="historyHour"></output><button type="button" data-history="hourNext">+1 hora</button></div><p>La hora seleccionada incluye los 60 minutos de esa hora.</p></section><p id="historyCount" role="status"></p><div id="historyTableWrap" tabindex="0" role="region" aria-label="Tabla del historial, desplazamiento horizontal"><table id="historyTable"><thead><tr><th scope="col">Habitación</th><th scope="col">Entrada</th><th scope="col">Salida prevista</th><th scope="col">Modalidad</th><th scope="col">Registrado por</th><th scope="col">Estado</th><th scope="col">Fecha de cierre</th><th scope="col">Cerrado por</th><th scope="col">Motivo</th><th scope="col">Detalles de entrada</th></tr></thead><tbody id="historyRows"></tbody></table></div>';
  $('historyDay').value=historyFilter.day;
  $('historyDay').onchange=()=>{historyFilter.day=$('historyDay').value;draw();};
  $('historyFilters').onclick=e=>{
    const action=e.target.closest('[data-history]')?.dataset.history;
    if(!action)return;
    const today=limaFields(state.now)[0];
    if(action==='all'){historyFilter.day='';historyFilter.hour=null;}
    if(action==='today')historyFilter.day=today;
    if(action==='yesterday')historyFilter.day=limaFields(state.now-86400)[0];
    if(action==='previous' || action==='next'){
      const base=Date.parse((historyFilter.day || today)+'T12:00:00-05:00')/1000;
      historyFilter.day=limaFields(base+(action==='next'?86400:-86400))[0];
    }
    if(action==='anyHour')historyFilter.hour=null;
    if(action==='hourBack' || action==='hourNext'){
      const current=historyFilter.hour ?? Number(limaFields(state.now)[1].slice(0,2));
      historyFilter.hour=(current+(action==='hourNext'?1:23))%24;
    }
    $('historyDay').value=historyFilter.day;
    draw();
  };
}
function draw(){
  $('title').textContent=page==='board'?'Habitaciones':'Historial de estancias';
  $('date').textContent=format(state.now,{dateStyle:'full'})+' · Huancayo-Chupaca';
  for(const id of ['board','history']) $(id).classList.toggle('active',page===id);
  const content=$('content');
  if(page==='history'){
    historyControls(content);
    const hour=historyFilter.hour;
    $('historyHour').textContent=hour===null?'Todo el día':(hour%12 || 12)+':00 '+(hour<12?'AM':'PM');
    document.querySelectorAll('[data-history]').forEach(button=>{
      const key=button.dataset.history;
      button.setAttribute('aria-pressed',String(
        (key==='all' && !historyFilter.day && hour===null) ||
        (key==='today' && historyFilter.day===limaFields(state.now)[0]) ||
        (key==='yesterday' && historyFilter.day===limaFields(state.now-86400)[0]) ||
        (key==='anyHour' && hour===null)));
    });
    const records=state.stays.filter(matchesHistory);
    $('historyCount').textContent=records.length?'Estancias encontradas · '+records.length:'No hay estancias con esta fecha y hora de entrada.';
    const rows=$('historyRows');
    rows.replaceChildren();
    for(const stay of records){
      const row=document.createElement('tr');
      const status=stay.withdrawn_at?'Retirada':stay.completed_at?'Hora concluida':
        stay.start>state.now?'Programada':stay.end<=state.now?'Hora cumplida':'Ocupada';
      const closedAt=stay.withdrawn_at || stay.completed_at;
      const values=[
        String(stay.room),stamp(stay.start),stamp(stay.end),
        stay.hours===null?'Personalizada':stay.hours>=24 && stay.hours%24===0?stay.hours/24+' días':stay.hours+' horas',stay.operator,status,
        closedAt?stamp(closedAt):'—',stay.withdrawn_by || stay.completed_by || '—',
        stay.reason || '—',[stay.details,...(stay.edits?.length?['Horario original · '+intervalText(stay.original_start,stay.original_end)]:[]),...(stay.edits || []).map(edit=>'Cambio · '+stamp(edit.changed_at)+' · '+edit.operator+' · '+intervalText(edit.start,edit.end)+' · '+edit.reason)].filter(Boolean).join('\n')
      ];
      values.forEach((value,index)=>{
        const cell=document.createElement(index===0?'th':'td');
        if(index===0)cell.scope='row';
        cell.textContent=value;
        if(index===5 && stay.withdrawn_at)cell.className='withdrawal-status';
        if(index===8 && stay.reason)cell.className='withdrawal-reason';
        row.append(cell);
      });
      rows.append(row);
    }
    if(!records.length){
      const row=document.createElement('tr');
      const cell=document.createElement('td');
      cell.colSpan=10;
      cell.className='history-empty';
      cell.textContent='No hay registros para los filtros seleccionados.';
      row.append(cell);
      rows.append(row);
    }
    return;
  }
  const used=state.rooms.filter(active).length;
  let stats=content.querySelector('.stats');
  if(!stats){
    content.innerHTML='<div class="stats">'+['Habitaciones','Disponibles','Ocupadas'].map(label=>
      '<div class="stat"><strong></strong>'+label+'</div>'
    ).join('')+'</div><div class="floors"></div>';
    stats=content.firstElementChild;
  }
  const counts=[state.rooms.length,state.rooms.length-used,used];
  stats.querySelectorAll('strong').forEach((number,index)=>{
    const value=String(counts[index]);
    if(number.textContent===value)return;
    if(number.textContent && !matchMedia('(prefers-reduced-motion: reduce)').matches){
      number.animate([{transform:'translateY(3px)',color:'#ac7110'},{transform:'translateY(0)',color:'#654710'}],{duration:420});
    }
    number.textContent=value;
  });
  const floors=content.querySelector('.floors');
  floors.replaceChildren();
  for(const floor of [1,2,3,4]){
    const rooms=state.rooms.filter(r=>Math.floor(r/100)===floor);
    floors.insertAdjacentHTML('beforeend','<h3>Piso '+floor+'</h3><div class="grid">'+rooms.map(r=>{
      const s=active(r);
      const ended=[...pendingEnds.values()].find(stay=>stay.room===r);
      const status=s?'● Ocupada<br>Entrada '+stamp(s.start)+'<br>Salida '+stamp(s.end)+'<br>Tiempo restante: '+remainingTime(s.end-state.now):ended?'Hora cumplida<br>Salida '+stamp(ended.end):'○ Disponible';
      return '<button class="room '+(s?'busy':ended?'time-up':'')+'" data-room="'+r+'"><strong>'+r+'</strong><span>'+status+'</span></button>';
    }).join('')+'</div>');
  }
}
async function refresh(){
  const ticket=++generation;
  try{
    const data=await request('state');
    if(ticket!==generation)return;
    let since=state?.now;
    let restored=[];
    if(!state || state.name!==data.name){
      pendingEnds.clear();
      $('expired').replaceChildren();
      let saved;
      try{saved=JSON.parse(localStorage.getItem('avisos-salida:'+data.name));}catch{}
      acknowledged=new Set(saved?.ack || []);
      restored=saved?.pending || [];
      since=saved?.seenAt;
    }
    state=data;
    for(const [id,old] of pendingEnds){
      const current=data.stays.find(s=>s.id===id);
      if(current && (current.end!==old.end || current.start!==old.start)){
        pendingEnds.delete(id);
        acknowledged.delete(id);
        document.querySelectorAll('[data-stay-id]').forEach(row=>{if(row.dataset.stayId===String(id))row.remove();});
      }
    }
    for(const stay of data.stays){
      if(stay.completed_at || stay.withdrawn_at){
        pendingEnds.delete(stay.id);
        document.querySelectorAll('[data-stay-id]').forEach(row=>{
          if(row.dataset.stayId===String(stay.id))row.remove();
        });
      }
    }
    const latest=new Map();
    for(const stay of data.stays){
      if(stay.start<=data.now && (!latest.has(stay.room) || latest.get(stay.room).start<stay.start))latest.set(stay.room,stay);
    }
    for(const stay of data.stays){
      if(stay.completed_at || stay.withdrawn_at || stay.end>data.now || acknowledged.has(stay.id))continue;
      const missed=since==null ? latest.get(stay.room)===stay : stay.end>since;
      if(missed || restored.includes(stay.id))void notifyEnd(stay,!restored.includes(stay.id));
    }
    saveAlerts();
    $('login').hidden=true; $('app').hidden=false;
    alertControls();
    $('sync').textContent='● Actualizado · '+format(state.now,{timeStyle:'medium'});
    draw();
    if($('modal').open)updateChoices();
  }catch(e){if(state)$('sync').textContent='Sin conexión · datos anteriores';}
}
function updatePin(value){
  $('pinValue').value=value.slice(0,6);
  const length=$('pinValue').value.length;
  $('pinDots').setAttribute('aria-label',length+' de 6 números ingresados');
  $('pinDots').querySelectorAll('span').forEach((dot,index)=>dot.classList.toggle('filled',index<length));
}
function pinKey(key){
  const value=$('pinValue').value;
  if(/^[0-9]$/.test(key))updatePin(value+key);
  if(key==='back')updatePin(value.slice(0,-1));
  if(key==='clear')updatePin('');
}
$('pinKeys').onclick=e=>{
  const button=e.target.closest('button');
  if(button)pinKey(button.dataset.digit ?? button.dataset.pinAction);
};
$('access').addEventListener('keydown',e=>{
  if(e.target.name==='name')return;
  if(/^[0-9]$/.test(e.key)){e.preventDefault();pinKey(e.key);}
  if(e.key==='Backspace'){e.preventDefault();pinKey('back');}
});
$('access').onsubmit=async e=>{
  e.preventDefault();
  if($('pinValue').value.length!==6){$('loginError').textContent='Ingresa los 6 números de tu PIN.';return;}
  try{
    await request('login',Object.fromEntries(new FormData(e.target)));
    e.target.reset(); updatePin(''); $('loginError').textContent=''; await refresh();
  }catch(err){updatePin('');$('loginError').textContent=err.message;}
};
$('logout').onclick=async()=>{try{await request('logout',{});showLogin();}catch(e){$('sync').textContent=e.message;}};
for(const id of ['board','history']) $(id).onclick=()=>{page=id;draw();};
let saving = false;
function limaFields(seconds){
  return new Date((seconds-5*3600)*1000).toISOString().slice(0,16).split('T');
}
const clockTime={entry:'00:00',exit:'00:00'};
function setClock(key,seconds){
  const [day,time]=limaFields(seconds);
  $(key==='entry'?'entryDay':'exitDate').value=day;
  clockTime[key]=time;
}
function clockSeconds(key){
  const date=$(key==='entry'?'entryDay':'exitDate').value;
  return Date.parse(date+'T'+clockTime[key]+':00-05:00')/1000;
}
function startSeconds(){
  return $('schedule').open?clockSeconds('entry'):state.now;
}
function exitSeconds(){return clockSeconds('exit');}
$('exitDate').oninput=updateChoices;
$('nearExit').onclick=()=>{
  setClock('exit',Math.round((state.now+120)/60)*60);
  updateChoices();
};
function durationEnd(start,mode){
  if(mode==='custom')return exitSeconds();
  if(mode==='days')return start+Number($('stayDays').value)*86400;
  if(mode==='month'){
    const date=new Date((start-5*3600)*1000);
    const day=date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth()+1);
    const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    date.setUTCDate(Math.min(day,last));
    return date.getTime()/1000+5*3600;
  }
  return start+Number(mode)*3600;
}
$('stayDays').oninput=updateChoices;
$('lessDays').onclick=()=>{ $('stayDays').stepDown();updateChoices(); };
$('moreDays').onclick=()=>{ $('stayDays').stepUp();updateChoices(); };
function updateChoices(){
  $('dayQuantity').textContent=$('stayDays').value+' días';
  const start=startSeconds();
  const stays=state.stays.filter(s=>s.room===selected);
  const busy=active(selected);
  const ended=state.stays.find(s=>s.room===selected && !s.withdrawn_at && !s.completed_at && s.end<=state.now);
  $('completeStay').hidden=!ended;
  $('completeStay').dataset.id=String(ended?.id || '');

  $('current').textContent=busy?'Ocupada':ended?'Hora cumplida':$('schedule').open?'Disponible':'Disponible · Entrada ahora';
  const displayed=busy || ended || state.stays.find(s=>s.room===selected && !s.withdrawn_at && !s.completed_at);
  $('emergencyEdit').hidden=!displayed;
  if(displayed && $('emergencyEdit').dataset.id!==String(displayed.id)){
    $('emergencyEdit').dataset.id=String(displayed.id);
    $('editStart').value=limaFields(displayed.start).join('T');
    $('editEnd').value=limaFields(displayed.end).join('T');
    $('editReason').value='';
  }
  $('savedDetails').textContent=displayed?.details?'Detalles registrados · '+displayed.details:'';
  $('stayTimes').hidden=!displayed;
  if($('withdraw').dataset.id!==String(busy?.id || '')){
    $('withdraw').open=false;
    $('reason').value='';
    $('withdrawError').textContent='';
  }
  $('withdraw').dataset.id=String(busy?.id || '');
  $('withdraw').hidden=!busy;
  if(displayed){
    $('actualStart').textContent=stamp(displayed.start);
    $('actualEnd').textContent=stamp(displayed.end);
  }
  $('chosenTime').textContent=Number.isFinite(start)?format(start,{weekday:'short',day:'numeric',month:'long',hour:'numeric',minute:'2-digit'}):'Elige un día y una hora';
  for(const button of document.querySelectorAll('[data-day]')){
    const match=$('entryDay').hidden && $('entryDay').value===limaFields(state.now+Number(button.dataset.day)*86400)[0];
    button.setAttribute('aria-pressed',String(match));
  }
  $('otherDay').setAttribute('aria-pressed',String(!$('entryDay').hidden));
  for(const button of document.querySelectorAll('.durations button')){
    const end=durationEnd(start,button.value);
    const overlap=stays.find(s=>s.start<end && (s.withdrawn_at || s.end)>start);
    button.disabled=saving || (button.value==='days' && (!$('stayDays').value || !$('stayDays').checkValidity())) || !Number.isFinite(start) || end<state.now+60 || Boolean(overlap);
    button.querySelector('em').textContent=overlap?'Ocupada de '+stamp(overlap.start)+' a '+stamp(overlap.withdrawn_at || overlap.end):end<state.now+60?'La salida debe estar al menos un minuto en el futuro':Number.isFinite(end)?'Salida · '+stamp(end):'Completa la fecha y la hora';
  }
  const customEnd=exitSeconds();
  $('exitClock').textContent=Number.isFinite(customEnd)?stamp(customEnd):'Elige el día de salida';
  const conflict=stays.find(s=>s.start<customEnd && (s.withdrawn_at || s.end)>start);
  const error=!Number.isFinite(start)?'Completa la entrada.':
    !Number.isFinite(customEnd)?'Elige una fecha y una hora.':
    customEnd<state.now+60?'La salida debe ser al menos un minuto posterior a la hora actual.':
    customEnd<=start?'La salida debe ser posterior a la entrada.':
    conflict?'La habitación está ocupada durante ese intervalo.':'';
  $('exitHint').textContent=error || 'Salida · '+stamp(customEnd);
  $('saveExit').disabled=saving || Boolean(error);

}
$('content').onclick=e=>{
  const btn=e.target.closest('[data-room]');
  if(!btn)return;
  selected=Number(btn.dataset.room);
  $('emergencyEdit').dataset.id='';
  $('emergencyEdit').open=false;
  $('editError').textContent='';
  $('completeError').textContent='';
  $('withdraw').open=false;
  $('reason').value='';
  $('withdrawError').textContent='';
  $('roomTitle').textContent='Habitación '+selected;
  $('schedule').open=false;
  $('entryDetails').value='';
  $('stayDays').value='1';
  $('otherDuration').open=false;
  setClock('entry',state.now);
  $('customExit').open=false;
  setClock('exit',Math.ceil((state.now+3*3600)/60)*60);
  $('entryDay').hidden=![0,1].some(n=>limaFields(state.now+n*86400)[0]===$('entryDay').value);
  $('stayError').textContent='';
  $('receipt').hidden=true;
  updateChoices();
  $('modal').showModal();
};
for(const button of document.querySelectorAll('[data-day]')){
  button.onclick=()=>{
    if(button.dataset.day==='0')setClock('entry',state.now);
    else $('entryDay').value=limaFields(state.now+86400)[0];
    $('entryDay').hidden=true;
    updateChoices();
  };
}
$('otherDay').onclick=()=>{
  $('entryDay').hidden=false;
  $('entryDay').focus();
  updateChoices();
};
for(const button of document.querySelectorAll('[data-minutes]')){
  button.onclick=()=>{
    const key=button.closest('[data-clock]').dataset.clock;
    const base=clockSeconds(key);
    if(!Number.isFinite(base))return;
    setClock(key,base+Number(button.dataset.minutes)*60);
    if(key==='entry' && ![0,1].some(n=>limaFields(state.now+n*86400)[0]===$('entryDay').value))$('entryDay').hidden=false;
    updateChoices();
  };
}
$('entryDay').oninput=updateChoices;
$('schedule').ontoggle=()=>{if(state)updateChoices();};
$('close').onclick=()=>$('modal').close();
$('confirmWithdraw').onclick=async()=>{
  const reason=$('reason').value.trim();
  if(!reason){
    $('withdrawError').textContent='Escribe el motivo antes de confirmar.';
    $('reason').focus();
    return;
  }
  $('confirmWithdraw').disabled=true;
  try{
    await request('withdraw',{id:Number($('withdraw').dataset.id),reason});
    $('modal').close();
    $('receipt').textContent='Habitación '+selected+' · Retiro guardado en el historial.';
    $('receipt').hidden=false;
    await refresh();
  }catch(err){$('withdrawError').textContent=err.message;}
  finally{$('confirmWithdraw').disabled=false;}
};
$('saveEdit').onclick=async()=>{
  const start=Date.parse($('editStart').value+':00-05:00')/1000;
  const end=Date.parse($('editEnd').value+':00-05:00')/1000;
  const reason=$('editReason').value.trim();
  if(!Number.isFinite(start) || !Number.isFinite(end) || end<=start || !reason){
    $('editError').textContent='Completa el motivo y una salida posterior a la entrada.';
    return;
  }
  $('saveEdit').disabled=true;
  try{
    await request('edit-schedule',{id:Number($('emergencyEdit').dataset.id),start,end,reason});
    $('modal').close();
    $('receipt').textContent='Horario actualizado y cambio guardado en el historial.';
    $('receipt').hidden=false;
    await refresh();
  }catch(error){$('editError').textContent=error.message;}
  finally{$('saveEdit').disabled=false;}
};
$('stay').onsubmit=async e=>{
  e.preventDefault();
  if(saving || !e.submitter || e.submitter.disabled)return;
  const custom=e.submitter.value==='custom';
  const mode=e.submitter.value;
  const hours=Number(mode);
  const start=startSeconds();
  const end=durationEnd(start,mode);
  const room=selected;
  saving=true;
  updateChoices();
  try{
    const details=$('entryDetails').value.trim();
    const payload=custom?{room,start,end,details}:{room,start,hours,details};
    if(mode==='days' || mode==='month'){delete payload.hours;payload.duration=mode;payload.days=Number($('stayDays').value);}
    await request('stays',payload);
    $('modal').close();
    $('receipt').textContent='Estancia registrada · Habitación '+room+' · '+intervalText(start,end);
    $('receipt').hidden=false;
    await refresh();
  }catch(err){$('stayError').textContent=err.message;}finally{saving=false;if(state)updateChoices();}
};
refresh();
setInterval(()=>{if(state)refresh();},3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden && state)refresh();});
if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});

