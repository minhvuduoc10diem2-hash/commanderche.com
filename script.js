(function(){
"use strict";

/* ===== board geometry (read from the reference image) ===== */
const ROWS=12, COLS=11, SP=42, MG=28;
const SEA_MAX=1;      // cols 0..1 = open sea (navy only)
const SHORE=2;        // col 2 = shoreline, everyone allowed
const FORDS=[5,7];    // river crossings open to all
const RIVER_LO=5, RIVER_HI=6;   // river runs between these two rows

const T={
  CMD :{n:"Tư lệnh",     c:"TL",v:10000},
  SCH :{n:"Sở chỉ huy",  c:"SCH",v:0},
  NAVY:{n:"Tàu chiến",   c:"TC",v:80},
  AIR :{n:"Không quân",  c:"KQ",v:45},
  ART :{n:"Pháo binh",   c:"PB",v:32},
  SAM :{n:"Tên lửa",     c:"TLa",v:24},
  TANK:{n:"Xe tăng",     c:"XT",v:22},
  AA  :{n:"Cao xạ",      c:"CX",v:14},
  ENG :{n:"Công binh",   c:"CB",v:12},
  INF :{n:"Bộ binh",     c:"BB",v:11},
  MIL :{n:"Dân quân",    c:"DQ",v:11},
};
const LIGHT=["CMD","INF","ENG","MIL","TANK"];   // may ford the deep river unaided
const CARRIER=["TANK","NAVY","AIR"];              // carriers for general troops (Engineers carry ONLY heavy gear, see HEAVY_RIDER)
const RIDER=["CMD","INF","MIL"];                // general troop transport: may board any CARRIER (or own HQ, CMD only)
const HEAVY_RIDER=["AA","ART","SAM"];           // heavy equipment (Cao xạ, Pháo binh, Tên lửa): carried ONLY by an Engineer, to cross the river
const SCH_BREAKERS=["ENG","TANK","ART","AIR"];  // only these may capture a headquarters
function canCapture(attackerType,target){ return target.type!=="SCH" || SCH_BREAKERS.includes(attackerType); }

const ORTHO=[[1,0],[-1,0],[0,1],[0,-1]];
const DIAG=[[1,1],[1,-1],[-1,1],[-1,-1]];
const ALL8=ORTHO.concat(DIAG);

/* Red's 19 pieces, exactly as positioned in the reference diagram [col,row] */
const RED_SETUP=[
  ["CMD",6,0],
  ["NAVY",1,1],["AIR",4,1],["SCH",5,1],["SCH",7,1],["AIR",8,1],
  ["ART",3,2],["SAM",6,2],["ART",9,2],
  ["NAVY",2,3],["AA",4,3],["TANK",5,3],["TANK",7,3],["AA",8,3],
  ["INF",2,4],["ENG",3,4],["MIL",6,4],["ENG",9,4],["INF",10,4],
];

let bd,turn,mode="local",human="RED",depth=3,sel=null,moves=[],log=[],
    lostR=[],lostB=[],last=null,over=false,warnSide=null,history=[];

const K=(r,c)=>r+","+c;
const inB=(r,c)=>r>=0&&r<ROWS&&c>=0&&c<COLS;
const at=(r,c)=>bd[K(r,c)];
const foe=(p,s)=>p&&p.side!==s;

function setup(){
  bd={};
  for(const [t,c,r] of RED_SETUP){
    bd[K(r,c)]={type:t,side:"RED",hero:false,r,c};
    const mr=ROWS-1-r;
    bd[K(mr,c)]={type:t,side:"BLUE",hero:false,r:mr,c};
  }
  turn="RED";sel=null;moves=[];log=[];lostR=[];lostB=[];last=null;over=false;warnSide=null;history=[];
}

/* ===== terrain ===== */
function isSea(r,c){ return c<=SEA_MAX; }
function isRiverDeep(r,c){ return (r===RIVER_LO||r===RIVER_HI) && !FORDS.includes(c) && c>SEA_MAX; }
function isWater(r,c){ return isSea(r,c) || isRiverDeep(r,c); }
function canStand(t,r,c){
  if(!inB(r,c))return false;
  if(isSea(r,c)) return t==="NAVY"||t==="AIR";
  return true;                       // col 2+ open to all, navy included (shoreline)
}
function navyOk(r,c){
  if(c<=SHORE) return true;                                   // the sea lane itself, any row
  return (r===RIVER_LO||r===RIVER_HI) && c<=FORDS[0];          // deep river, up to the near ford
}
function standOk(t,r,c){
  if(!canStand(t,r,c))return false;
  if(t==="NAVY"&&!navyOk(r,c))return false;
  return true;
}
// heavy ground units (not in LIGHT) may never wade a deep-river cell on a quiet move;
// they may still land there when the move is a capture (crossing to take a piece on the far bank).
function heavyBlocked(t,r,c){ return isRiverDeep(r,c) && !LIGHT.includes(t); }

/* ===== air-defence coverage owned by the enemy of `side` ===== */
function adZone(side){
  const z=new Set();
  for(const p of Object.values(bd)){
    if(p.side===side)continue;
    if(p.type==="AA"){
      z.add(K(p.r,p.c));
      for(const [a,b] of ALL8) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
    if(p.type==="SAM"){
      z.add(K(p.r,p.c));
      for(const [a,b] of ORTHO) for(let s=1;s<=2;s++) if(inB(p.r+a*s,p.c+b*s)) z.add(K(p.r+a*s,p.c+b*s));
      for(const [a,b] of DIAG) if(inB(p.r+a,p.c+b)) z.add(K(p.r+a,p.c+b));
    }
  }
  return z;
}

/* ===== generic slider ===== */
function slide(p,dirs,max){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(!o){
        if(heavyBlocked(p.type,r,c))break;             // can't wade deep water without being carried
        if(standOk(p.type,r,c))out.push({r,c}); else break;
      } else {
        // capturing across the river is always allowed, even for a heavy unit, at any river segment
        if(foe(o,p.side)&&standOk(p.type,r,c)&&canCapture(p.type,o))out.push({r,c,cap:o});
        break;
      }
    }
  }
  return out;
}
// stand still and capture a Navy target within reach (Infantry/Engineer/AA/Militia); heroic adds a segment
function waterAdjCapture(p){
  const out=[], range=p.hero?2:1;
  for(const [dr,dc] of ALL8){
    for(let s=1;s<=range;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&o.type==="NAVY"&&isWater(r,c)) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}
/* fire without moving */
function fire(p,dirs,max,pred){
  const out=[];
  for(const [dr,dc] of dirs){
    for(let s=1;s<=max;s++){
      const r=p.r+dr*s,c=p.c+dc*s;
      if(!inB(r,c))break;
      const o=at(r,c);
      if(o){ if(foe(o,p.side)&&(!pred||pred(o,r,c))) out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true}); break; }
    }
  }
  return out;
}

function gen(p){
  if(p.type==="SCH") return [];               // a headquarters never moves or attacks
  const h=p.hero?1:0;
  switch(p.type){
    case "CMD":{
      const out=[];
      for(const [dr,dc] of ORTHO){
        for(let s=1;s<ROWS+COLS;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(!o){ if(standOk("CMD",r,c))out.push({r,c}); else break; }
          else { if(s===1&&foe(o,p.side)&&canCapture("CMD",o))out.push({r,c,cap:o}); break; }
        }
      }
      return out.filter(m=>!faceOff(p,m));
    }
    case "INF": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "ENG": return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "AA":  return slide(p,p.hero?ALL8:ORTHO,1+h).concat(waterAdjCapture(p));
    case "MIL": return slide(p,ALL8,1+h).concat(waterAdjCapture(p));
    case "TANK":return slide(p,ORTHO,2+h)
      .concat(fire(p,ORTHO,2+h,(o,r,c)=>o.type==="NAVY"&&isWater(r,c)));
    case "SAM": return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h)).filter(m=>!m.cap||m.cap.type!=="NAVY");
    case "ART": {   // moves AND captures by replacement: straight 1-2 cells, diagonal (45°) 1 cell (+1 if hero)
      const shipPred=(o,r,c)=>o.type==="NAVY"&&isWater(r,c);
      return slide(p,ORTHO,2+h).concat(slide(p,DIAG,1+h))
        .concat(fire(p,ORTHO,2+h,shipPred)).concat(fire(p,DIAG,1+h,shipPred));
    }
    case "AIR": {
      const R=4+h,Z=adZone(p.side),out=[];
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=R;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;                         // only the board edge stops a flight path
          const o=at(r,c), inZ=Z.has(K(r,c));
          if(o && foe(o,p.side) && inZ && canCapture("AIR",o)){
            out.push({r,c,cap:o,trade:true});          // anything inside hostile airspace: one-for-one
            continue;                                   // still free to keep flying past it
          }
          if(!o){ if(!inZ && !isSea(r,c)) out.push({r,c}); continue; }  // safe, empty & landable
          if(inZ) continue;                             // a friendly unit sheltering there: fly on past
          if(foe(o,p.side) && canCapture("AIR",o)){
            const canReplace = !isSea(r,c);              // an aircraft can never finish a move into the sea
            if(canReplace) out.push({r,c,cap:o});
            if(o.type!=="AIR") out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});   // bomb & return to base
          } else if(!foe(o,p.side) && o.type==="NAVY" && !o.rider){
            out.push({r,c,ride:true});                  // land aboard a friendly ship (carrier)
          }
          // any blocker (friend or foe) never stops the flight - keep scanning past it
        }
      }
      return out;
    }
    case "NAVY": {
      const out=[], sailCaps=new Set(), sailR=4+h;
      for(const [dr,dc] of ALL8){      // sails (and fires its missile point-blank) up to 4 segments, any direction
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c)||!navyOk(r,c))break;
          const o=at(r,c);
          if(!o){ out.push({r,c}); continue; }
          if(foe(o,p.side)&&canCapture("NAVY",o)){ out.push({r,c,cap:o}); sailCaps.add(K(r,c)); }
          break;
        }
      }
      for(const [dr,dc] of ALL8){      // anti-ship missile: Navy-only target, stand-fire only when not directly sailable
        for(let s=1;s<=sailR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&o.type==="NAVY"&&foe(o,p.side)&&!sailCaps.has(K(r,c)))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
          // a guided missile isn't stopped by ordinary obstructions - keep scanning past anything else
        }
      }
      const gunR=3+h;                   // onboard gun: dry-land targets only, always stand-fire
      for(const [dr,dc] of ALL8){
        for(let s=1;s<=gunR;s++){
          const r=p.r+dr*s,c=p.c+dc*s;
          if(!inB(r,c))break;
          const o=at(r,c);
          if(o&&foe(o,p.side)&&o.type!=="NAVY"&&c>SHORE&&canCapture("NAVY",o))
            out.push({r:p.r,c:p.c,cap:o,tr:r,tc:c,stay:true});
        }
      }
      return out;
    }
  }
  return [];
}

function cmdOf(s){
  for(const p of Object.values(bd)) if(p.type==="CMD"&&p.side===s) return p;
  for(const p of Object.values(bd)) if(p.rider&&p.rider.type==="CMD"&&p.rider.side===s) return {type:"CMD",side:s,hero:p.rider.hero,r:p.r,c:p.c,mounted:true};
  return undefined;
}

function faceOff(p,m){
  const e=cmdOf(p.side==="RED"?"BLUE":"RED");
  if(!e)return false;
  if(m.r!==e.r&&m.c!==e.c)return false;
  const a=K(p.r,p.c),b=K(m.r,m.c),sa=bd[a],sb=bd[b];
  delete bd[a]; bd[b]={...p,r:m.r,c:m.c};
  let blocked=false;
  if(m.r===e.r){const lo=Math.min(m.c,e.c),hi=Math.max(m.c,e.c);for(let c=lo+1;c<hi;c++)if(at(m.r,c)){blocked=true;break;}}
  else {const lo=Math.min(m.r,e.r),hi=Math.max(m.r,e.r);for(let r=lo+1;r<hi;r++)if(at(r,m.c)){blocked=true;break;}}
  bd[a]=sa; if(sb)bd[b]=sb; else delete bd[b];
  return !blocked;
}

function cloneBoard(b){
  const out={};
  for(const k in b){ const p=b[k]; out[k]=p.rider?{...p,rider:{...p.rider}}:{...p}; }
  return out;
}

function legal(side){
  const out=[];
  for(const p of Object.values(bd)){
    if(p.side!==side)continue;
    for(const m of gen(p)) out.push({from:{r:p.r,c:p.c},...m,pt:p.type});
    if(p.rider){   // the passenger may hop off and move on its own
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      for(const m of gen(v)) out.push({from:{r:p.r,c:p.c},...m,pt:v.type,off:true});
    }
  }
  for(const p of Object.values(bd)){   // board a friendly carrier
    if(p.side!==side||p.rider)continue;
    const general=RIDER.includes(p.type), heavy=HEAVY_RIDER.includes(p.type);
    if(!general&&!heavy)continue;
    for(const [dr,dc] of (p.type==="MIL"?ALL8:ORTHO)){
      const r=p.r+dr,c=p.c+dc;
      if(!inB(r,c))continue;
      const o=at(r,c);
      if(!o||o.side!==side||o.rider)continue;
      if(general&&(CARRIER.includes(o.type)||(o.type==="SCH"&&p.type==="CMD")))
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
      else if(heavy&&o.type==="ENG")
        out.push({from:{r:p.r,c:p.c},r,c,pt:p.type,ride:true});
    }
  }
  return out;
}

// is `side`'s commander currently attacked? Uses raw pseudo-legal generation only - never calls
// legalSafe - so it can't recurse into itself while legalSafe is busy filtering.
function inCheck(side){
  const cmd=cmdOf(side);
  if(!cmd) return false;
  const enemy=side==="RED"?"BLUE":"RED";
  for(const p of Object.values(bd)){
    if(p.side!==enemy) continue;
    if(gen(p).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    if(p.rider){
      const v={type:p.rider.type,side:p.side,hero:p.rider.hero,r:p.r,c:p.c};
      if(gen(v).some(x=>x.cap&&x.r===cmd.r&&x.c===cmd.c)) return true;
    }
  }
  return false;
}

// the actual moves a player may choose: every pseudo-legal move that does not leave their own
// commander in check afterward (this is what makes responding to a check mandatory).
function legalSafe(side){
  return legal(side).filter(m=>{
    const snap=cloneBoard(bd);
    sim(m);
    const safe=!inCheck(side);
    bd=snap;
    return safe;
  });
}

/* ===== apply ===== */
function take(p){ if(!p)return; (p.side==="BLUE"?lostB:lostR).push(p.type); }

function play(m,quiet){
  if(!quiet)history.push({bd:JSON.parse(JSON.stringify(bd)),turn,log:log.slice(),lostR:lostR.slice(),lostB:lostB.slice(),last});
  const fk=K(m.from.r,m.from.c), mv=bd[fk];
  if(!mv)return;
  let got=null, actor=null;

  // destroying an occupied square destroys everything on it - a combined piece goes down together
  function destroyStack(r,c){
    const there=at(r,c);
    if(!there)return null;
    if(there.rider) take({...there.rider,side:there.side});
    take(there);
    delete bd[K(r,c)];
    return there;
  }

  if(m.ride){
    const car=at(m.r,m.c);
    car.rider={type:mv.type,side:mv.side,hero:mv.hero};
    delete bd[fk]; actor=car;
    note(m,mv.type,null,mv.type==="AIR"&&car.type==="NAVY"?"hạ cánh xuống tàu":mv.type==="CMD"&&car.type==="SCH"?"vào sở chỉ huy":"lên xe");
  } else if(m.stay){
    got={...m.cap};
    destroyStack(m.tr,m.tc);
    actor=mv;
    note(m,(m.off&&mv.rider)?mv.rider.type:mv.type,got,"bắn tại chỗ");   // a passenger firing from its carrier never harms the carrier
  } else if(m.off){
    const host=at(m.from.r,m.from.c), rd=host.rider;
    delete host.rider;
    if(m.cap){got={...m.cap};destroyStack(m.r,m.c);}
    if(m.trade){ take({...rd}); note(m,rd.type,got,"đổi mạng"); }
    else {
      bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};
      actor=bd[K(m.r,m.c)];
      note(m,rd.type,got,"xuống xe");
    }
  } else if(m.trade){
    got={...m.cap};
    destroyStack(m.r,m.c);
    if(mv.rider) take({...mv.rider,side:mv.side});
    take(mv);
    delete bd[fk];
    note(m,mv.type,got,"đổi mạng");
  } else {
    if(m.cap){ got={...m.cap}; destroyStack(m.r,m.c); }
    delete bd[fk];
    const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
    if(mv.rider)np.rider=mv.rider;
    bd[K(m.r,m.c)]=np; actor=np;
    note(m,mv.type,got,null);
  }

  last={a:m.from,b:{r:m.r,c:m.c}};

  if(actor&&!actor.hero){         // promote whoever now attacks the enemy commander
    if(gen(actor).some(x=>x.cap&&x.cap.type==="CMD")){
      actor.hero=true;
      if(!quiet)toast((actor.side==="RED"?"Đỏ":"Xanh")+": "+T[actor.type].n+" thành quân ANH HÙNG ★");
    }
  }

  if(!cmdOf("RED")) return finish("BLUE","Tư lệnh Đỏ đã bị bắt.");
  if(!cmdOf("BLUE")) return finish("RED","Tư lệnh Xanh đã bị bắt.");

  turn = turn==="RED"?"BLUE":"RED";
  if(!legalSafe(turn).length) return finish(turn==="RED"?"BLUE":"RED","Bên "+(turn==="RED"?"Đỏ":"Xanh")+" hết nước đi.");

  warnSide = inCheck(turn)?turn:null;
  if(!quiet){ draw(); setTimeout(aiTurn,60); }
}

function note(m,t,got,tag){
  let s=(log.length+1)+". "+(turn==="RED"?"Đỏ":"Xanh")+" "+T[t].n+" "+m.from.c+","+m.from.r+"→"+(m.tc??m.c)+","+(m.tr??m.r);
  if(got)s+=" (ăn "+T[got.type].n+")";
  if(tag)s+=" ["+tag+"]";
  log.push(s);
}
function finish(w,why){
  over=true;
  document.getElementById('ovT').textContent=(w==="RED"?"ĐỎ":"XANH")+" THẮNG";
  document.getElementById('ovP').textContent=why;
  document.getElementById('over').classList.add('on');
  draw();
}

/* ===== icons ===== */
const ICON={
CMD:`<svg viewBox="0 0 24 24"><path fill="#fff" d="M5.4 9.6C5.4 5.4 8.3 2.6 12 2.6s6.6 2.8 6.6 7z"/><rect x="5.4" y="8.2" width="13.2" height="1.6" fill="#000" fill-opacity=".5"/><path fill="#000" fill-opacity=".6" d="M12.00 3.70L12.47 4.95L13.81 5.01L12.76 5.85L13.12 7.14L12.00 6.40L10.88 7.14L11.24 5.85L10.19 5.01L11.53 4.95z"/><path fill="#fff" d="M3.8 10.4h16.4c0 1.4-1.4 2.3-3.1 2.3H6.9c-1.7 0-3.1-.9-3.1-2.3z"/><path fill="#fff" d="M7.7 13.3h8.6v1.6c0 2.7-1.9 4.5-4.3 4.5s-4.3-1.8-4.3-4.5z"/><path fill="#fff" d="M1.6 23.4c0-3.3 2.6-5 6.3-5.6l4.1 3.3 4.1-3.3c3.7.6 6.3 2.3 6.3 5.6z"/><path fill="none" stroke="#000" stroke-opacity=".5" stroke-width=".9" stroke-linecap="round" d="M12 21.2v2.2M7.7 12.9h8.6"/><path fill="#000" fill-opacity=".55" d="M5.20 19.90L5.52 20.76L6.44 20.80L5.72 21.37L5.96 22.25L5.20 21.75L4.44 22.25L4.68 21.37L3.96 20.80L4.88 20.76z"/><path fill="#000" fill-opacity=".55" d="M18.80 19.90L19.12 20.76L20.04 20.80L19.32 21.37L19.56 22.25L18.80 21.75L18.04 22.25L18.28 21.37L17.56 20.80L18.48 20.76z"/></svg>`,
SCH:'<svg viewBox="0 0 24 24"><path fill="#fff" d="M3 11L12 4l9 7v1H3z"/><rect x="4" y="12" width="16" height="8" fill="#fff"/><rect x="10.5" y="14.5" width="3" height="5.5" fill-opacity=".55" fill="#000"/></svg>',
NAVY:'<svg viewBox="0 0 24 24"><path fill="#fff" d="M2 16h20l-2.5 5H4.5zM11 3h2v4h4l-1 6H8L7 7h4z"/><circle cx="12" cy="2" r="1.4" fill="#fff"/></svg>',
AIR:'<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 2c.8 0 1.4 1.4 1.5 3.4L22 11v2l-8.4-1.6v4.4l2.6 2v1.8L12 18.6l-4.2 1h0v-1.8l2.6-2v-4.4L2 13v-2l8.5-5.6C10.6 3.4 11.2 2 12 2z"/></svg>',
ART:`<svg viewBox="0 0 24 24"><g transform="rotate(-24 9.5 12.5)"><rect x="5" y="10.6" width="6.2" height="3.8" rx="1.6" fill="#fff"/><rect x="9.5" y="11.3" width="12" height="2.4" rx="1" fill="#fff"/><rect x="19" y="10.2" width="3.6" height="4.2" rx=".9" fill="#fff"/><rect x="19" y="11.4" width="3.6" height=".9" fill="#000" fill-opacity=".5"/></g><path fill="#fff" d="M9.3 9.4l3.4 1v6.6H9.3z"/><path d="M11.4 17.6L2.2 21.6" stroke="#fff" stroke-width="2.3" stroke-linecap="round"/><circle cx="11.2" cy="17.4" r="5" fill="#fff"/><circle cx="11.2" cy="17.4" r="3.5" fill="#000" fill-opacity=".55"/><g stroke="#fff" stroke-width="1.1" stroke-linecap="round"><path d="M11.2 14.3v6.2M8.1 17.4h6.2M9 15.2l4.4 4.4M13.4 15.2L9 19.6"/></g><circle cx="11.2" cy="17.4" r="1.3" fill="#fff"/></svg>`,
SAM:'<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 1.5c1.9 2.3 2.9 5.3 2.9 8.4v5.6h-5.8V9.9c0-3.1 1-6.1 2.9-8.4z"/><path fill="#fff" d="M9.1 12.5L5.5 18h3.6zM14.9 12.5L18.5 18h-3.6zM9.6 17h4.8l-2.4 5.3z"/></svg>',
TANK:'<svg viewBox="0 0 24 24"><rect x="1.5" y="14" width="21" height="6" rx="3" fill="#fff"/><path fill="#fff" d="M6 9.5c0-1.7 1.6-3 4-3h3c2.4 0 4 1.3 4 3v3.5H6z"/><rect x="14" y="8.4" width="9" height="2.2" rx="1.1" fill="#fff"/></svg>',
AA:'<svg viewBox="0 0 24 24"><rect x="4" y="15" width="16" height="5" rx="1.6" fill="#fff"/><rect x="7.5" y="4" width="2.4" height="11" rx="1.2" fill="#fff" transform="rotate(-14 8.7 9.5)"/><rect x="14.1" y="4" width="2.4" height="11" rx="1.2" fill="#fff" transform="rotate(14 15.3 9.5)"/></svg>',
ENG:`<svg viewBox="0 0 24 24"><g transform="rotate(45 12 12)"><rect x="10.9" y="3.2" width="2.2" height="12.6" rx="1.1" fill="#fff"/><path fill="#fff" d="M8.4 15h7.2l-.9 5.6c-.2 1.5-1.4 2.6-2.7 2.6s-2.5-1.1-2.7-2.6z"/><path d="M12 16.4v5" stroke="#000" stroke-opacity=".5" stroke-width=".9" stroke-linecap="round"/><path d="M9.2 2.4h5.6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></g><g transform="rotate(-45 12 12)"><rect x="10.9" y="5" width="2.2" height="18" rx="1.1" fill="#fff" stroke="#000" stroke-opacity=".6" stroke-width="1" paint-order="stroke"/><path fill="#fff" stroke="#000" stroke-opacity=".6" stroke-width="1" paint-order="stroke" d="M1.6 9.8C4 6 7.8 4.6 12 4.6s8 1.4 10.4 5.2c-.7.3-1.5.1-2-.5C18.6 7.6 15.6 6.7 12 6.7S5.4 7.6 3.6 9.3c-.5.6-1.3.8-2 .5z"/></g></svg>`,
INF:'<svg viewBox="0 0 24 24"><path fill="#fff" d="M4.5 10.5a7.5 7.5 0 0 1 15 0v1.2h-15z"/><circle cx="12" cy="6.4" r="1.7" fill="#fff"/><path fill="#fff" d="M3 14h18v2.2H3z"/><path fill="#fff" d="M8 17h8l-1.6 4h-4.8z"/></svg>',
MIL:`<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 1.6L21.6 9.6c-2.6 1-5.8 1.6-9.6 1.6S5 10.6 2.4 9.6z"/><path fill="none" stroke="#000" stroke-opacity=".45" stroke-width=".9" d="M12 4.2l4 5.2M12 4.2L8 9.4"/><circle cx="12" cy="13.4" r="3.1" fill="#fff"/><path fill="#fff" d="M3.2 23.4c0-4 3.4-6.4 8.8-6.4s8.8 2.4 8.8 6.4z"/><g transform="rotate(-30 12 19.4)"><rect x="3.2" y="18.4" width="17.6" height="2" rx=".7" fill="#fff" stroke="#000" stroke-opacity=".6" stroke-width=".8"/><rect x="14.6" y="17.1" width="5.6" height="1.5" rx=".4" fill="#fff" stroke="#000" stroke-opacity=".6" stroke-width=".6"/></g></svg>`,
};

/* ===== rendering ===== */
const stage=document.getElementById('stage'), terr=document.getElementById('terrain');
const X=c=>MG+c*SP, Y=r=>MG+(ROWS-1-r)*SP;
const W=MG*2+(COLS-1)*SP, H=MG*2+(ROWS-1)*SP;

function terrainSVG(){
  const riverTop=Y(RIVER_HI), riverBot=Y(RIVER_LO);
  let s=`<svg width="${W}" height="${H}" style="display:block">`;
  s+=`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
  s+=`<rect x="${X(0)-MG/2}" y="0" width="${X(SHORE)-X(0)+MG/2}" height="${H}" fill="var(--sea)"/>`;
  s+=`<rect x="0" y="${riverTop}" width="${W}" height="${riverBot-riverTop}" fill="var(--sea)"/>`;
  for(const f of FORDS){                    // ford markings
    s+=`<g stroke="#9a8464" stroke-width="2.4" stroke-linecap="round" opacity=".85">`;
    for(let i=0;i<5;i++){
      const fx=X(f)-9+Math.random()*0, ox=[-7,2,-2,8,4][i], oy=riverTop+5+i*((riverBot-riverTop-10)/4);
      s+=`<line x1="${fx+ox}" y1="${oy}" x2="${fx+ox+3}" y2="${oy+7}"/>`;
    }
    s+=`</g>`;
  }
  s+=`<g stroke="var(--grid)" stroke-width="1.6">`;
  for(let c=0;c<COLS;c++) s+=`<line x1="${X(c)}" y1="${Y(ROWS-1)}" x2="${X(c)}" y2="${Y(0)}"/>`;
  for(let r=0;r<ROWS;r++) s+=`<line x1="${X(0)}" y1="${Y(r)}" x2="${X(COLS-1)}" y2="${Y(r)}"/>`;
  s+=`</g>`;
  s+=`<rect x="${X(0)-MG/2}" y="${Y(ROWS-1)-MG/2}" width="${(COLS-1)*SP+MG}" height="${(ROWS-1)*SP+MG}" fill="none" stroke="var(--frame)" stroke-width="3"/>`;
  s+=`<g fill="#6b6b5e" font-size="10" font-family="Georgia">`;
  for(let c=0;c<COLS;c++) s+=`<text x="${X(c)-3}" y="${H-4}">${c}</text>`;
  for(let r=0;r<ROWS;r++) s+=`<text x="2" y="${Y(r)+4}">${r}</text>`;
  s+=`</g></svg>`;
  return s;
}

function draw(){
  stage.style.width=W+"px"; stage.style.height=H+"px";
  terr.innerHTML=terrainSVG();
  [...stage.querySelectorAll('.pc,.mk,.lm')].forEach(e=>e.remove());
  const D=SP*0.86, tilt=stage.classList.contains('flat')?0:46;

  if(last){
    for(const q of [last.a,last.b]){
      const d=document.createElement('div');
      d.className='lm';
      d.style.cssText=`left:${X(q.c)-D/2}px;top:${Y(q.r)-D/2}px;width:${D}px;height:${D}px`;
      stage.appendChild(d);
    }
  }
  for(const p of Object.values(bd)){
    const e=document.createElement('div');
    e.className='pc '+p.side+(sel&&sel.r===p.r&&sel.c===p.c?' sel':'');
    e.style.cssText=`left:${X(p.c)-D/2}px;top:${Y(p.r)-D/2}px;width:${D}px;height:${D}px;transform:rotateX(-${tilt}deg) translateZ(8px)`;
    e.innerHTML=ICON[p.type]+(p.hero?'<span class="hero">★</span>':'')+(p.rider?'<span class="car"></span>':'');
    e.title=T[p.type].n+(p.hero?" ★":"")+(p.rider?(p.type==="NAVY"&&p.rider.type==="AIR"?" (tàu sân bay)":" (cõng "+T[p.rider.type].n+")"):"");
    e.onclick=ev=>{ev.stopPropagation();tap(p.r,p.c);};
    stage.appendChild(e);
  }
  const groups=new Map();
  for(const m of moves){
    const key=(m.tr??m.r)+","+(m.tc??m.c);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(m);
  }
  for(const [key,group] of groups){
    const [tr,tc]=key.split(",").map(Number);
    const anyCap=group.some(x=>x.cap);
    const d=document.createElement('div'), s=anyCap?D*0.5:D*0.34;
    d.className='mk'+(anyCap?' cap':'')+(group.length>1?' multi':'');
    d.style.cssText=`left:${X(tc)-s/2}px;top:${Y(tr)-s/2}px;width:${s}px;height:${s}px;transform:rotateX(-${tilt}deg) translateZ(6px)`;
    stage.appendChild(d);
    const hit=document.createElement('div');
    hit.className='pc';
    hit.style.cssText=`left:${X(tc)-D/2}px;top:${Y(tr)-D/2}px;width:${D}px;height:${D}px;background:none;border:none;box-shadow:none;transform:rotateX(-${tilt}deg) translateZ(9px);z-index:5`;
    hit.onclick=ev=>{ev.stopPropagation();chooseAmong(group);};
    stage.appendChild(hit);
  }

  document.getElementById('turnTxt').textContent="Lượt: "+(turn==="RED"?"Đỏ":"Xanh");
  document.getElementById('dot').className="dot "+turn;
  const w=document.getElementById('warn');
  if(warnSide){w.classList.add('on');w.textContent="TƯ LỆNH "+(warnSide==="RED"?"ĐỎ":"XANH")+" BỊ CHIẾU!";}
  else w.classList.remove('on');
  const cap=(el,arr,cls)=>{el.innerHTML=arr.map(t=>`<span class="${cls}">${T[t].c}</span>`).join("");};
  cap(document.getElementById('lostR'),lostR,'RED');
  cap(document.getElementById('lostB'),lostB,'BLUE');
  document.getElementById('log').innerHTML=log.slice().reverse().map(x=>`<div>${x}</div>`).join("");
}

// human-readable label for one candidate move, so a multi-option cell can be explained clearly
function describeMove(m){
  const host=at(m.from.r,m.from.c), stacked=host&&host.rider;
  if(m.ride){
    const carrier=at(m.r,m.c);
    if(m.pt==="CMD"&&carrier&&carrier.type==="SCH") return "Vào ẩn náu trong Sở chỉ huy";
    return "Cõng lên "+(carrier?T[carrier.type].n:"phương tiện");
  }
  if(m.off) return "Tách ra đi một mình"+(m.cap?" — ăn "+T[m.cap.type].n:"");
  if(m.trade) return "Đổi 1–1 — tiêu diệt "+T[m.cap.type].n+" (cả hai cùng mất)";
  if(m.stay) return "Bắn tại chỗ — tiêu diệt "+T[m.cap.type].n+", đứng nguyên vị trí";
  if(m.cap){
    let s="Thế chỗ — tiêu diệt "+T[m.cap.type].n;
    if(stacked) s+=" (đi cả đôi)";
    return s;
  }
  if(stacked) return "Đi cả đôi (mang theo "+T[host.rider.type].n+")";
  return "Di chuyển tới đây";
}

// when a target cell has more than one legal option (e.g. thế chỗ vs bắn tại chỗ, or đi đôi vs tách ra),
// let the player pick explicitly instead of silently guessing which one they meant.
function chooseAmong(group){
  if(group.length===1){ sel=null; moves=[]; play(group[0]); return; }
  const back=document.createElement('div');
  back.className='mb on';
  const box=document.createElement('div');
  box.className='md';
  box.style.maxWidth='320px';
  box.innerHTML='<h3 style="margin-bottom:10px">Chọn cách đi</h3>';
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;flex-direction:column;gap:8px';
  group.forEach(m=>{
    const b=document.createElement('button');
    b.className='b p';
    b.style.textAlign='left';
    b.textContent=describeMove(m);
    b.onclick=ev=>{ev.stopPropagation();document.body.removeChild(back);sel=null;moves=[];play(m);};
    wrap.appendChild(b);
  });
  box.appendChild(wrap);
  back.appendChild(box);
  back.onclick=()=>{document.body.removeChild(back);};
  box.onclick=ev=>ev.stopPropagation();
  document.body.appendChild(back);
}

function tap(r,c){
  if(over)return;
  if(mode==="ai"&&turn!==human)return;
  if(sel){
    const group=moves.filter(x=>(x.tr??x.r)===r&&(x.tc??x.c)===c);
    if(group.length){sel=null;moves=[];chooseAmong(group);return;}
  }
  const p=at(r,c);
  if(p&&p.side===turn&&!(p.type==="SCH"&&!p.rider)){ sel={r,c}; moves=legalSafe(turn).filter(m=>m.from.r===r&&m.from.c===c); }
  else { sel=null; moves=[]; }
  draw();
}
stage.onclick=()=>{sel=null;moves=[];draw();};

/* ===== AI ===== */
const score=()=>{let s=0;for(const p of Object.values(bd)){let v=T[p.type].v+(p.hero?8:0);if(p.rider)v+=T[p.rider.type].v*.6;s+=(p.side==="RED"?1:-1)*v;}return s;};
function orderMoves(ms){
  // captures and trades first - lets alpha-beta cut off the (usually weaker) quiet moves sooner
  return ms.slice().sort((a,b)=>((b.cap?1:0)+(b.trade?1:0))-((a.cap?1:0)+(a.trade?1:0)));
}
function ab(d,side,al,be){
  if(!cmdOf("RED"))return -1e6-d;
  if(!cmdOf("BLUE"))return 1e6+d;
  if(d<=0)return score();
  const ms=orderMoves(legal(side)); if(!ms.length)return score();
  if(side==="RED"){let v=-Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.max(v,ab(d-1,"BLUE",al,be));bd=s;al=Math.max(al,v);if(al>=be)break;}return v;}
  let v=Infinity;for(const m of ms){const s=cloneBoard(bd);sim(m);v=Math.min(v,ab(d-1,"RED",al,be));bd=s;be=Math.min(be,v);if(al>=be)break;}return v;
}
function sim(m){
  const fk=K(m.from.r,m.from.c),mv=bd[fk]; if(!mv)return;
  if(m.ride){const c2=at(m.r,m.c);c2.rider={type:mv.type,side:mv.side,hero:mv.hero};delete bd[fk];return;}
  if(m.stay){delete bd[K(m.tr,m.tc)];return;}
  if(m.off){const h=at(m.from.r,m.from.c),rd=h.rider;delete h.rider;if(m.cap)delete bd[K(m.r,m.c)];if(!m.trade)bd[K(m.r,m.c)]={type:rd.type,side:rd.side,hero:rd.hero,r:m.r,c:m.c};return;}
  if(m.trade){delete bd[K(m.r,m.c)];delete bd[fk];return;}
  if(m.cap)delete bd[K(m.r,m.c)];
  delete bd[fk];
  const np={type:mv.type,side:mv.side,hero:mv.hero,r:m.r,c:m.c};
  if(mv.rider)np.rider=mv.rider;
  bd[K(m.r,m.c)]=np;
}
function aiTurn(){
  if(mode!=="ai"||over||turn===human)return;
  const ms=legalSafe(turn); if(!ms.length)return;
  let best=null,bs=turn==="RED"?-Infinity:Infinity;
  for(const m of orderMoves(ms).sort(()=>Math.random()-.3)){
    const s=cloneBoard(bd); sim(m);
    const v=ab(depth-1,turn==="RED"?"BLUE":"RED",-Infinity,Infinity)+Math.random()*.4;
    bd=s;
    if(turn==="RED"?v>bs:v<bs){bs=v;best=m;}
  }
  if(best)play(best);
}

/* ===== ui ===== */
let tt;
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>e.classList.remove('on'),2400);}
const $=id=>document.getElementById(id);
function reset(){setup();draw();if(mode==="ai"&&human==="BLUE")setTimeout(aiTurn,300);}
$('bNew').onclick=reset;
$('ovB').onclick=()=>{$('over').classList.remove('on');reset();};
$('bFlat').onclick=()=>{stage.classList.toggle('flat');draw();};
$('bRules').onclick=()=>$('rules').classList.add('on');
$('bClose').onclick=()=>$('rules').classList.remove('on');
$('bUndo').onclick=()=>{
  if(!history.length)return;
  let n=(mode==="ai"&&history.length>1)?2:1;
  let s; while(n-->0&&history.length)s=history.pop();
  bd=s.bd;turn=s.turn;log=s.log;lostR=s.lostR;lostB=s.lostB;last=s.last;
  over=false;sel=null;moves=[];warnSide=null;$('over').classList.remove('on');draw();
};
$('mLocal').onclick=()=>{mode="local";$('mLocal').classList.add('on');$('mAI').classList.remove('on');
  $('aiBox').style.display='none';$('modeTxt').textContent="2 người · 1 máy";reset();};
$('mAI').onclick=()=>{mode="ai";$('mAI').classList.add('on');$('mLocal').classList.remove('on');
  $('aiBox').style.display='flex';$('modeTxt').textContent="Đấu với máy";reset();};
$('lvl').onchange=e=>{depth=+e.target.value;};
$('sRed').onclick=()=>{human="RED";$('sRed').classList.add('on');$('sBlue').classList.remove('on');reset();};
$('sBlue').onclick=()=>{human="BLUE";$('sBlue').classList.add('on');$('sRed').classList.remove('on');reset();};

$('leg').innerHTML=Object.entries(T).map(([k,v])=>`<div><i>${ICON[k]}</i>${v.n}</div>`).join("");
$('ruleList').innerHTML=[
 ["CMD","đi ngang/dọc bao xa cũng được (không chéo), miễn không vướng vật cản; ăn quân chỉ trong phạm vi 1 đoạn. Có thể bước vào Sở chỉ huy của mình để ẩn náu (đứng lên trên), và rời đi bất cứ lúc nào."],
 ["SCH","đứng yên tuyệt đối, không tự đi/ăn quân, chỉ là vật cản. Chỉ Công binh, Xe tăng, Pháo binh, Không quân phá được. Nếu Tư lệnh đang ẩn trong đó mà bị phá, Tư lệnh bị diệt."],
 ["INF","đi/ăn ngang dọc 1 đoạn (tiến, lùi, sang ngang). Đứng tại chỗ bắn tàu chiến cách 1 đoạn (kể cả chéo) nếu tàu ở dưới nước."],
 ["ENG","như Bộ binh; đặc biệt chỉ Công binh mới cõng được khí tài nặng (Pháo binh, Cao xạ, Tên lửa) để vượt đoạn sông sâu. Công binh không cõng Tư lệnh, Bộ binh hay Dân quân."],
 ["AA","như Bộ binh; tạo vùng cấm bay bán kính 1 quanh nó. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["MIL","như Bộ binh nhưng đi/ăn/bắn tàu được cả 8 hướng kể cả chéo 45°."],
 ["TANK","đi/ăn ngang dọc 1–2 đoạn; đứng tại chỗ bắn tàu chiến trong tầm đó, không cần thế chỗ."],
 ["SAM","đi/ăn quân mặt đất và trên không trong vành đai 2 đoạn (trục) / 1 đoạn (chéo). Không thể nhắm vào tàu chiến. Tạo vùng cấm bay lớn. Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["ART","đi và ăn thẳng (ngang/dọc) 1–2 đoạn; đi và ăn chéo 45° 1 đoạn. Ăn quân bằng cách thế chỗ như quân thường. Đứng tại chỗ bắn được tàu chiến trong đúng tầm đó (thẳng 1–2, chéo 1). Muốn qua đoạn sông sâu phải nhờ Công binh cõng."],
 ["AIR","bay 8 hướng 1–4 đoạn, vượt qua mọi vật cản. Ăn quân được chọn thế chỗ hoặc bay về chỗ cũ nếu thế chỗ không an toàn (riêng ăn máy bay địch bắt buộc thế chỗ). Không được hạ cánh xuống biển. Bay vào vùng cấm phòng không: nếu có mục tiêu ở đó thì cả hai cùng bị tiêu diệt (1 đổi 1); nếu ô trống thì coi như bị bắn rơi (không đi được). Có thể hạ cánh đậu trên Tàu chiến của mình."],
 ["NAVY","tổ hợp 3 trong 1. Tự thân di chuyển thẳng/ngang/chéo tối đa 4 đoạn, bị chặn bởi vật cản đầu tiên trên đường đi (không bay qua được), chỉ trong dải biển và đoạn sông sâu tới chỗ ngầm gần nhất. Tên lửa hải đối hải: ăn tàu địch trong tầm đó, phải thế chỗ nếu đi thẳng tới được, nếu không (bị chắn) thì bắn tại chỗ. Pháo hạm: bắn mục tiêu trên bộ trong tầm 1–3 đoạn, luôn bắn tại chỗ (không thế chỗ). Cao xạ trên tàu tạo vùng cấm bay bán kính 1. Có thể chở Tư lệnh/Bộ binh/Dân quân hoặc làm tàu sân bay chở Không quân."],
].map(([k,d])=>`<li><b>${T[k].n}</b>: ${d}</li>`).join("");

depth=+$('lvl').value;
setup();draw();
})();