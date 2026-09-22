'use strict';
(() => {
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
  const uuid = value => { const s=String(value).trim().toLowerCase().replace(/^0x/,''); return /^[0-9a-f]{4}$|^[0-9a-f]{8}$/.test(s) ? s.padStart(8,'0')+'-0000-1000-8000-00805f9b34fb' : s; };
  const frame = payload => { const a=[0xfb,payload.length+2,...payload]; return [...a,a.slice(1).reduce((x,y)=>x+y,0)&255,0xfc]; };
  // QZ #1344 original SmartTreadmill capture. Start/Stop also verified on this user's Centra.
  const start = () => frame([0xa2,1,1]);
  const stop = () => frame([0xa2,4,1]);
  const query = i => { if(!Number.isInteger(i)||i<0||i>3)throw Error('Invalid query');return frame([0xa0,i,1]); };
  const speed = tenths => { if(!Number.isInteger(tenths)||tenths<10||tenths>60)throw Error('Speed must be 1.0–6.0 km/h');return frame([0xa1,2,1,tenths,0]); };
  // QZ ZIPRO driver and original app: force=0 echoes speed without requesting a change.
  const heartbeat = tenths => { if(!Number.isInteger(tenths)||tenths<0||tenths>60)throw Error('Invalid reported speed');return frame([0xa1,2,0,tenths,0]); };
  const profile = ['fd 08 a0 00 f1 01 00 05 9f fe','fd 07 a0 01 17 06 15 da fe','fd 10 a0 02 3c 0a 00 00 0c 00 00 01 00 00 00 00 05 fe','fd 08 a0 03 01 a9 fc fc 4d fe'];
  // Both query-3 replies were captured from this user's treadmill; keep other fields exact.
  const matchesProfile = (index, bytes) => hex(bytes)===profile[index] || (index===3 && hex(bytes)==='fd 08 a0 03 01 a9 fc 00 51 fe');
  function decoder(emit) {
    let buffer=[];
    return { clear(){buffer=[];}, push(bytes){
      buffer.push(...bytes);
      while(buffer.length){
        if(buffer[0]!==0xfd){buffer.shift();continue;}
        if(buffer.length<2)break;
        const length=buffer[1]+2;
        if(length<5||length>64){buffer.shift();continue;}
        if(buffer.length<length)break;
        const f=buffer.slice(0,length);
        if(f[length-1]!==0xfe || (f.slice(1,-2).reduce((a,b)=>a+b,0)&255)!==f[length-2]){buffer.shift();continue;}
        buffer.splice(0,length);emit(f);
      }
    }};
  }
  function status(f){
    if(f[2]!==0xa1)return null;
    // Matched to physical sleep by the user in two captured reports.
    if(hex(f)==='fd 04 a1 08 ad fe')return {phase:8,speed:0,target:null,countdown:null};
    if(f.length===7 && f[3]===0 && f[4]===0)return {phase:0,speed:0,target:0,countdown:null};
    if(f.length===7 && f[3]===1)return {phase:1,speed:0,target:null,countdown:f[4]};
    if(f.length!==18)return null;
    const phase=f[3];
    return {phase,speed:phase===1 ? 0 : f[5],target:f[4],countdown:phase===1 ? f[10] : null};
  }
  window.TreadmillProtocol=Object.freeze({hex,uuid,start,stop,query,speed,heartbeat,matchesProfile,profile:Object.freeze(profile),decoder,status});
})();
