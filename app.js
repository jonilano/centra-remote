'use strict';
(() => {
  const P=window.TreadmillProtocol, $=id=>document.getElementById(id);
  const serviceId=P.uuid('fff0');
  const state={version:7,opened:new Date().toISOString(),deviceName:null,connection:'disconnected',verified:false,telemetry:null,packets:0,actions:[],events:[]};
  let device,writer,notify,notificationListener,disconnectListener;
  let generation=0,commandEpoch=0,connecting=false,initializing=false,initAttempted=false,replyWaiter;
  let statusSerial=0,stopBeforeStatus=0,heartbeatPending=false;
  let transport=Promise.resolve(),lastStatusAt=0,mayMove=false,startPending=false,stopInFlight=false,stopRequested=false;
  let speedUnconfirmed=false,speedPending=null,startDeadline,stopDeadline,speedDeadline,wakeLock=null,notice='Turn on the treadmill, then connect.',alarm='';
  const connected=()=>!!device?.gatt?.connected && !!writer;
  const fresh=()=>lastStatusAt>0 && Date.now()-lastStatusAt<3500;
  const idle=()=>state.telemetry?.phase===0 && fresh();
  const active=()=>mayMove || startPending || [1,2,4].includes(state.telemetry?.phase);
  const foreground=()=>document.visibilityState!=='hidden';
  const format=n=>(n/10).toFixed(1);
  function log(message,data,action=false){
    const record={time:new Date().toISOString(),message,...(data===undefined?{}:{data})};
    state.events.push(record); if(state.events.length>500)state.events.shift();
    if(action){state.actions.push(record);if(state.actions.length>150)state.actions.shift();}
    if($('reportDetails').open)$('report').value=report();
  }
  function report(){return JSON.stringify({...state,commandState:{startPending,stopRequested,stopInFlight,speedPending,mayMove},message:notice,alarm},null,2);}
  function canStart(){return connected() && state.verified && idle() && foreground() && !connecting && !initializing && !startPending && !stopRequested && !stopInFlight && !speedPending;}
  function canSpeed(){return connected() && state.verified && fresh() && state.telemetry?.phase===2 && foreground() && !startPending && !stopRequested && !stopInFlight && !speedPending;}
  function baseSpeed(){const t=state.telemetry;return Number.isInteger(t?.target)&&t.target>=10&&t.target<=60?t.target:t?.speed;}
  function render(){
    const live=connected(),t=state.telemetry;
    $('connection').textContent=connecting?'Connecting…':live?(initializing?'Checking treadmill…':state.verified?'Connected':'Connected · limited'):'Not connected';
    $('connect').disabled=connecting||live;$('connect').textContent=device?'Reconnect':'Connect';
    $('all').disabled=connecting||live;
    $('disconnect').disabled=!live||active()||stopInFlight||stopRequested;
    $('start').disabled=!canStart();$('stop').disabled=!live||stopInFlight;
    const base=baseSpeed();$('slower').disabled=!canSpeed()||!Number.isInteger(base)||base<=10;$('faster').disabled=!canSpeed()||!Number.isInteger(base)||base>=60;
    $('speed').textContent=live&&fresh()&&t ? t.phase===1?String(t.countdown??'…'):format(t.speed) : '—';
    $('unit').textContent=live&&fresh()&&t?.phase===1?'starting in':'km/h';
    $('phase').textContent=!live?'Ready when you are':!fresh()?'Waiting for status':startPending?'Starting…':stopRequested?'Stopping…':({0:'Ready',1:'Get ready',2:'Walking',4:'Slowing down',5:'Stopped'}[t?.phase]??'Check treadmill');
    $('target').textContent=!live?'Connect to see your treadmill’s speed.':!fresh()?'Speed is unavailable until fresh data arrives.':speedPending?'Requesting '+format(speedPending.target)+' km/h…':t?.phase===1?'The treadmill’s own countdown':t?.phase===2&&t.target>=10&&t.target!==t.speed?'Target '+format(t.target)+' km/h · adjusting':t?.phase===2?'Live speed from your treadmill':state.verified?'Press Start when you’re ready.':initializing?'Checking your treadmill automatically…':initAttempted?'Identification failed. See the message below.':'Waiting to check your treadmill…';
    $('message').textContent=notice;$('alarm').textContent=alarm;$('alarm').hidden=!alarm;
  }
  async function keepAwake(){
    if(!navigator.wakeLock?.request || wakeLock || !foreground())return;
    try{const lock=await navigator.wakeLock.request('screen');if(!active()){await lock.release();return;}wakeLock=lock;lock.addEventListener?.('release',()=>{if(wakeLock===lock)wakeLock=null;});}catch{}
  }
  function releaseAwake(){const lock=wakeLock;wakeLock=null;if(lock)Promise.resolve(lock.release()).catch(()=>{});}
  function cancelReply(reason){replyWaiter?.reject(new Error(reason));}
  function cancelSpeed(){clearTimeout(speedDeadline);speedPending=null;}
  // Serial writes; Stop invalidates all queued Start/speed actions before queuing its packets.
  function send(packet,label,epoch=commandEpoch){
    const gen=generation;
    const run=()=>new Promise((resolve,reject)=>{
      if(gen!==generation || epoch!==commandEpoch || !connected()){reject(new Error('Command cancelled or Bluetooth disconnected'));return;}
      let settled=false;
      const deadline=setTimeout(()=>finish(new Error('Bluetooth write timed out')),1200);
      function finish(error){if(settled)return;settled=true;clearTimeout(deadline);error?reject(error):resolve();}
      log('TX '+label,{hex:P.hex(packet)},true);
      try{const bytes=Uint8Array.from(packet);const result=typeof writer.writeValueWithResponse==='function'?writer.writeValueWithResponse(bytes):writer.writeValue(bytes);Promise.resolve(result).then(()=>finish(),finish);}catch(error){finish(error);}
    });
    const result=transport.then(run,run);transport=result.catch(()=>{});return result;
  }
  function query(index,epoch){
    let cancel;
    const response=new Promise((resolve,reject)=>{
      let done=false;const deadline=setTimeout(()=>finish(new Error('Treadmill identification timed out')),4000);
      function finish(error,frame){if(done)return;done=true;clearTimeout(deadline);if(replyWaiter===waiter)replyWaiter=null;error?reject(error):resolve(frame);}
      const waiter={index,resolve:frame=>finish(null,frame),reject:error=>finish(error)};replyWaiter=waiter;cancel=waiter.reject;
    });
    return Promise.all([response,send(P.query(index),'identify '+index,epoch).catch(error=>{cancel(error);throw error;})]).then(([frame])=>frame);
  }
  async function identify(){
    if(initializing||initAttempted||!connected()||!idle()||!foreground()||stopInFlight||stopRequested)return;
    initializing=true;initAttempted=true;state.verified=false;const gen=generation,epoch=commandEpoch;
    notice='Checking your treadmill…';render();
    try{
      for(let i=0;i<4;i++){
        if(gen!==generation||epoch!==commandEpoch||!idle()||!foreground())throw new Error('Identification interrupted');
        const f=await query(i,epoch);
        if(!P.matchesProfile(i,f))throw new Error('This treadmill’s identification differs from the verified model');
      }
      if(gen!==generation||epoch!==commandEpoch)return;
      state.verified=true;notice='Ready. Start uses the treadmill’s own countdown.';log('Treadmill profile verified',undefined,true);
    }catch(error){if(gen===generation){notice=error.message+'. Disconnect and reconnect to try again.';log('Identification failed',error.message,true);}}
    finally{if(gen===generation){initializing=false;render();}}
  }
  function finishStopped(){
    mayMove=false;releaseAwake();
    if(stopRequested&&!stopInFlight&&statusSerial>stopBeforeStatus){stopRequested=false;clearTimeout(stopDeadline);notice='Treadmill reports stopped.';log('Stop confirmed by telemetry',undefined,true);}
  }
  const decoder=P.decoder(f=>{
    log('RX',{hex:P.hex(f)});
    if(replyWaiter&&f[2]===0xa0&&f[3]===replyWaiter.index)replyWaiter.resolve(f);
    const t=P.status(f);if(!t)return;
    const previousPhase=state.telemetry?.phase;
    if([1,2].includes(previousPhase)&&[0,4,5].includes(t.phase)&&!stopRequested){notice='The treadmill is stopping without a Stop request from this page.';log('Treadmill initiated stop',{previousPhase,phase:t.phase,speed:t.speed,target:t.target},true);}
    state.telemetry=t;lastStatusAt=Date.now();statusSerial++;
    if(![0,1,2,4,5].includes(t.phase)){
      alarm='Unrecognized treadmill state. Check the machine and use its power switch if needed.';
      if(active()&&!stopRequested)void stop('Unrecognized treadmill state');
    }
    if([1,2,4].includes(t.phase)||t.speed>0)mayMove=true;
    if(startPending&&[1,2].includes(t.phase)){startPending=false;clearTimeout(startDeadline);notice=t.phase===1?'Starting after the countdown.':'Use − and + to adjust speed.';log('Start confirmed by telemetry',undefined,true);}
    if(t.phase===2&&!stopRequested&&!alarm&&!speedUnconfirmed&&!speedPending)notice=state.verified?'Use − and + to adjust speed.':'Press Stop to finish connecting before using Start or speed controls.';
    if(speedPending&&t.phase===2&&t.target===speedPending.target){speedPending.confirmed=true;settleSpeed();}
    if(t.phase!==2&&speedPending)cancelSpeed();
    if((t.phase===0||t.phase===5)&&t.speed===0&&!startPending)finishStopped();
    render();
    if(idle()&&!connecting&&!initAttempted)void identify();
  });
  async function start(){
    if(!canStart())return;
    const gen=generation,epoch=++commandEpoch;startPending=true;mayMove=true;alarm='';notice='Start requested. Waiting for the treadmill’s countdown…';render();void keepAwake();
    startDeadline=setTimeout(()=>{if(gen===generation&&startPending){alarm='Start response was not confirmed. Sending Stop.';void stop('Start confirmation timed out');}},4000);
    try{await send(P.start(),'Start',epoch);}catch(error){if(gen===generation&&epoch===commandEpoch){log('Start write failed',error.message,true);alarm='Start delivery is uncertain. Sending Stop.';void stop('Start write failed');}}
  }
  async function stop(reason='User pressed Stop'){
    if(stopInFlight)return;
    const gen=generation,epoch=++commandEpoch;
    cancelReply('Stop requested');cancelSpeed();clearTimeout(startDeadline);clearTimeout(stopDeadline);
    startPending=false;stopRequested=true;stopInFlight=true;stopBeforeStatus=statusSerial;notice='Stopping…';log('Stop requested',reason,true);render();
    let delivered=0;
    for(let i=0;i<3;i++){
      try{await send(P.stop(),'Stop',epoch);delivered++;}catch(error){log('Stop write failed',error.message,true);}
      if(gen!==generation||!connected())break;
    }
    if(gen!==generation)return;
    stopInFlight=false;
    if(!delivered){alarm='Stop could not be sent. If the belt is moving, use the power switch now.';notice='Stop unconfirmed.';}
    else{notice='Stop sent. Waiting for the treadmill to stop.';}
    if(fresh()&&[0,5].includes(state.telemetry?.phase)&&state.telemetry.speed===0)finishStopped();
    if(stopRequested){stopDeadline=setTimeout(()=>{if(gen===generation&&stopRequested){alarm='Stop is not confirmed. If the belt is moving, use the power switch now.';notice='Stop unconfirmed.';render();}},6000);}
    render();
  }
  function settleSpeed(){
    const p=speedPending;if(!p||!p.acknowledged||!p.confirmed)return;
    clearTimeout(speedDeadline);log('Speed target confirmed',{kmh:p.target/10},true);speedPending=null;notice='Speed target accepted.';render();
  }
  async function changeSpeed(delta){
    if(!canSpeed()||![-1,1].includes(delta))return;
    const target=baseSpeed()+delta;if(!Number.isInteger(target)||target<10||target>60)return;
    const gen=generation,epoch=commandEpoch,p={target,acknowledged:false,confirmed:false};speedPending=p;speedUnconfirmed=false;notice='Requesting '+format(target)+' km/h…';render();
    speedDeadline=setTimeout(()=>{if(speedPending===p){speedPending=null;speedUnconfirmed=true;notice='Speed change was not confirmed. The display still shows the treadmill’s reported speed.';log('Speed response timed out',{target},true);render();}},4000);
    try{await send(P.speed(target),'speed '+format(target),epoch);if(speedPending===p){p.acknowledged=true;settleSpeed();}}
    catch(error){if(gen===generation&&epoch===commandEpoch&&speedPending===p){cancelSpeed();log('Speed write failed',error.message,true);alarm='Speed command delivery is uncertain. Sending Stop.';void stop('Speed write failed');}}
  }
  function cleanup(){
    commandEpoch++;cancelReply('Disconnected');cancelSpeed();clearTimeout(startDeadline);clearTimeout(stopDeadline);
    if(notify&&notificationListener)notify.removeEventListener('characteristicvaluechanged',notificationListener);
    writer=notify=notificationListener=null;decoder.clear();state.verified=false;state.telemetry=null;speedUnconfirmed=false;lastStatusAt=0;
    heartbeatPending=false;initializing=false;initAttempted=false;startPending=false;stopInFlight=false;stopRequested=false;releaseAwake();transport=Promise.resolve();
  }
  function onDisconnected(){
    const wasMoving=active();generation++;cleanup();connecting=false;mayMove=false;state.connection='disconnected';
    notice='Disconnected. Tap Reconnect when ready.';if(wasMoving)alarm='Bluetooth disconnected. If the belt is moving, use the treadmill’s power switch.';
    log('Disconnected',{wasMoving},true);render();
  }
  async function connect(allDevices=false){
    if(connecting||device?.gatt?.connected)return;
    if(!navigator.bluetooth?.requestDevice){notice='Open this page in Bluefy to connect by Bluetooth.';render();return;}
    if(!window.isSecureContext){notice='Open the HTTPS link in Bluefy.';render();return;}
    connecting=true;alarm='';notice='Choose RZ_TreadMil.';const gen=++generation;render();
    try{
      const selected=(!allDevices&&device)?device:await navigator.bluetooth.requestDevice(allDevices?{acceptAllDevices:true,optionalServices:[serviceId]}:{filters:[{namePrefix:'RZ'},{namePrefix:'Rz'},{namePrefix:'rz'}],optionalServices:[serviceId]});
      if(gen!==generation)return;
      if(device&&disconnectListener)device.removeEventListener('gattserverdisconnected',disconnectListener);
      device=selected;disconnectListener=onDisconnected;device.addEventListener('gattserverdisconnected',disconnectListener);
      cleanup();mayMove=false;state.deviceName=device.name||'(unnamed)';state.connection='connecting';
      const server=await device.gatt.connect();if(gen!==generation){if(server.connected)server.disconnect();return;}
      const service=await server.getPrimaryService(serviceId);if(gen!==generation)return;
      const chars=await service.getCharacteristics();if(gen!==generation)return;
      writer=chars.find(c=>P.uuid(c.uuid)===P.uuid('fff2')&&c.properties.write);
      notify=chars.find(c=>P.uuid(c.uuid)===P.uuid('fff1')&&(c.properties.notify||c.properties.indicate));
      if(!writer||!notify)throw new Error('Expected treadmill channels were not found');
      state.characteristics=chars.map(c=>({uuid:c.uuid,properties:['write','read','notify','indicate'].filter(p=>c.properties[p])}));
      notificationListener=e=>{if(gen!==generation)return;const v=e.target.value;state.packets++;decoder.push(Array.from(new Uint8Array(v.buffer,v.byteOffset,v.byteLength)));};
      notify.addEventListener('characteristicvaluechanged',notificationListener);await notify.startNotifications();if(gen!==generation)return;
      state.connection='connected';notice='Waiting for treadmill status…';log('Connected',{name:state.deviceName},true);
    }catch(error){
      if(gen!==generation)return;
      if(device&&disconnectListener)device.removeEventListener('gattserverdisconnected',disconnectListener);
      if(device?.gatt?.connected)device.gatt.disconnect();cleanup();state.connection='disconnected';
      notice=error.name==='NotFoundError'?'No device selected. Try Connect again.':error.message;log('Connection error',notice,true);
    }finally{if(gen===generation){connecting=false;render();if(idle())void identify();}}
  }
  $('connect').addEventListener('click',()=>connect());$('all').addEventListener('click',()=>connect(true));
  $('start').addEventListener('click',start);$('stop').addEventListener('click',()=>stop());
  $('slower').addEventListener('click',()=>changeSpeed(-1));$('faster').addEventListener('click',()=>changeSpeed(1));
  $('disconnect').addEventListener('click',()=>{if(device?.gatt?.connected&&!active()&&!stopRequested&&!stopInFlight)device.gatt.disconnect();});
  $('copy').addEventListener('click',async()=>{
    $('report').value=report();
    try{await navigator.clipboard.writeText(report());$('copyStatus').textContent='Copied. Paste the report into our chat.';}catch{$('reportDetails').open=true;$('report').focus();$('report').select();$('report').setSelectionRange(0,$('report').value.length);$('copyStatus').textContent='Press and hold the report, then choose Copy.';}
  });
  $('reportDetails').addEventListener('toggle',()=>{if($('reportDetails').open)$('report').value=report();});
  function leaving(){cancelReply('Page left the foreground');if(active()&&!stopRequested)void stop('Page backgrounded or closed');releaseAwake();}
  document.addEventListener('visibilitychange',()=>{log('Page visibility',document.visibilityState,true);if(!foreground())leaving();else if(active())void keepAwake();render();});
  window.addEventListener('pagehide',leaving);
  setInterval(()=>{
    if(connected()&&!fresh()&&active()&&!stopRequested){alarm='Treadmill status was lost. Sending Stop; use the power switch if needed.';void stop('Status stale');}
    // One outstanding heartbeat at most; Stop invalidates queued writes through commandEpoch.
    if(connected()&&state.verified&&fresh()&&foreground()&&state.telemetry?.phase===2&&!startPending&&!stopRequested&&!stopInFlight&&!speedPending&&!heartbeatPending){
      const gen=generation,epoch=commandEpoch;
      heartbeatPending=true;
      send(P.heartbeat(state.telemetry.speed),'heartbeat',epoch).catch(error=>{
        if(gen===generation&&epoch===commandEpoch){log('Heartbeat write failed',error.message,true);alarm='Bluetooth communication failed. Sending Stop.';void stop('Heartbeat write failed');}
      }).finally(()=>{if(gen===generation)heartbeatPending=false;});
    }
    render();
  },500);
  log('Remote opened. Connecting never sends Start.',undefined,true);
  if(!navigator.bluetooth?.requestDevice)notice='Open this page in Bluefy to connect by Bluetooth.';
  render();
  if(document.modelContext?.registerTool){try{Promise.resolve(document.modelContext.registerTool({name:'read_treadmill_diagnostics',description:'Read connection and treadmill status. Does not send commands.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw Error('Expected an empty object');return JSON.parse(report());}})).catch(()=>{});}catch{}}
})();
