import { useState, useEffect, useRef, useCallback } from "react";

// ============================================================
// EMBRYO ENGINE v0.9 — True Germ Layer Formation
//
// KEY FIX: All daughter cells born as STEM. They differentiate
// based on BFS depth (distance to nearest empty cell):
//   depth 1 (surface)     → ECTODERM (or NEURAL at midline+AP)
//   depth 2 (sub-surface) → MESODERM
//   depth 3-5             → ENDODERM
//   depth 6+              → stays STEM (niche)
//
// Zero energy sinks. 100% death recycle. Perfect conservation.
// ============================================================

const GS = 200;
const CT = {EMPTY:0,STEM:1,ECTO:2,MESO:3,ENDO:4,NERVE:5,MUSCLE:6,VESSEL:7};
const NAMES = ["","Stem","Ecto","Meso","Endo","Neural","Muscle","Vessel"];
const COLORS = [
  [0,0,0],
  [215,205,165],
  [65,150,225],
  [220,65,65],
  [240,180,45],
  [145,72,235],
  [210,45,75],
  [40,205,140],
];
const BORDER_COLORS = COLORS.map(([r,g,b])=>[r*0.3|0,g*0.3|0,b*0.3|0]);
const NT = 8;

const TOTAL_E = 250000;
const DIV_THRESH = 30;
const DIFF_DIV_MULT = 1.4;
const DIV_COOLDOWN = 14;
const SENESCENCE = 500;
const SEN_SPREAD = 150;
const SHARE_RATE = 0.05;
const M_DIFF = 0.13;
const M_DECAY = 0.96;
const NOISE = 0.02;
const NM = 4;
const DIFF_AGE = 12;
const DX=[1,-1,0,0],DY=[0,0,1,-1];

function create(){
  const N=GS*GS;
  const cells=new Uint8Array(N);
  const energy=new Float32Array(N);
  const morph=Array.from({length:NM},()=>new Float32Array(N));
  const age=new Uint16Array(N);
  const maxAge=new Uint16Array(N);
  const cx=GS>>1,cy=GS>>1;
  const seeds=[];
  for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++)
    if(dx*dx+dy*dy<=10) seeds.push([dx,dy]);
  const se=TOTAL_E/seeds.length;
  for(const[dx,dy] of seeds){
    const i=(cy+dy)*GS+(cx+dx);
    cells[i]=CT.STEM;energy[i]=se;
    morph[0][i]=0.3+Math.random()*0.3;
    maxAge[i]=SENESCENCE+Math.floor((Math.random()-0.5)*SEN_SPREAD);
  }
  for(let r=1;r<=6;r++){
    const ai=(cy-r)*GS+cx;
    if(ai>=0&&ai<N) morph[3][ai]+=0.08*r;
  }
  return{cells,energy,morph,age,maxAge,tick:0,cellCount:seeds.length,
    typeCounts:(()=>{const t=Array(NT).fill(0);t[1]=seeds.length;return t;})(),
    totalEnergy:TOTAL_E,births:0,deaths:0};
}

const wr=v=>((v%GS)+GS)%GS;
const gi=(x,y)=>wr(y)*GS+wr(x);

function assignMaxAge(type){
  const base=type===CT.STEM?SENESCENCE*0.6:
    type===CT.NERVE?SENESCENCE*2.5:
    type===CT.MUSCLE?SENESCENCE*1.6:
    type===CT.VESSEL?SENESCENCE*1.8:
    type===CT.ECTO?SENESCENCE*1.3:
    type===CT.ENDO?SENESCENCE*1.4:
    type===CT.MESO?SENESCENCE*0.9:SENESCENCE;
  return Math.floor(base+(Math.random()-0.5)*SEN_SPREAD);
}

function computeDepth(cells){
  const N=GS*GS;
  const depth=new Uint8Array(N);
  const queue=[];
  for(let i=0;i<N;i++){
    if(cells[i]===CT.EMPTY) depth[i]=0;
    else depth[i]=255;
  }
  for(let y=0;y<GS;y++) for(let x=0;x<GS;x++){
    const i=y*GS+x;
    if(cells[i]===CT.EMPTY) continue;
    for(let d=0;d<4;d++){
      if(cells[gi(x+DX[d],y+DY[d])]===CT.EMPTY){
        depth[i]=1;queue.push(i);break;
      }
    }
  }
  let head=0;
  while(head<queue.length){
    const ci=queue[head++];
    const cy2=ci/GS|0,cx2=ci%GS;
    const nd=depth[ci]+1;
    for(let d=0;d<4;d++){
      const ni=gi(cx2+DX[d],cy2+DY[d]);
      if(depth[ni]===255){depth[ni]=nd;queue.push(ni);}
    }
  }
  return depth;
}

function simStep(s){
  const{cells,energy,morph,age,maxAge}=s;
  const N=GS*GS;
  const nc=new Uint8Array(cells);
  const ne=new Float32Array(energy);
  const nm=morph.map(m=>new Float32Array(m));
  const na=new Uint16Array(age);
  const nma=new Uint16Array(maxAge);
  for(let i=0;i<N;i++) nma[i]=maxAge[i];
  let births=0,deaths=0;

  const dr=[M_DIFF,M_DIFF*2.5,M_DIFF*1.8,M_DIFF*1.6];
  for(let m=0;m<NM;m++){
    const src=morph[m],dst=nm[m],r=dr[m];
    for(let y=0;y<GS;y++) for(let x=0;x<GS;x++){
      const i=y*GS+x;
      dst[i]=(src[i]+r*(src[gi(x-1,y)]+src[gi(x+1,y)]+src[gi(x,y-1)]+src[gi(x,y+1)]-4*src[i]))*M_DECAY;
      if(dst[i]<0.0003)dst[i]=0;if(dst[i]>8)dst[i]=8;
    }
  }

  for(let y=0;y<GS;y++) for(let x=0;x<GS;x++){
    const i=y*GS+x;
    if(cells[i]===CT.EMPTY) continue;
    const a=nm[0][i],b=nm[1][i];
    nm[0][i]=Math.max(0,a+0.02*(a*a/(1+b)-a+0.04)+(Math.random()-0.5)*NOISE);
    nm[1][i]=Math.max(0,b+0.02*(a*a-b));
  }

  const depth=computeDepth(cells);

  for(let y=0;y<GS;y++) for(let x=0;x<GS;x++){
    const i=y*GS+x;
    if(cells[i]===CT.EMPTY) continue;
    const ri=gi(x+1,y);
    if(cells[ri]!==CT.EMPTY){const f=(ne[i]-ne[ri])*SHARE_RATE;ne[i]-=f;ne[ri]+=f;}
    const di=gi(x,y+1);
    if(cells[di]!==CT.EMPTY){const f=(ne[i]-ne[di])*SHARE_RATE;ne[i]-=f;ne[di]+=f;}
  }

  const living=[];
  for(let y=0;y<GS;y++) for(let x=0;x<GS;x++)
    if(cells[y*GS+x]!==CT.EMPTY) living.push(x|(y<<16));
  for(let i=living.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [living[i],living[j]]=[living[j],living[i]];
  }

  let sumX=0,sumY=0;
  for(const pk of living){sumX+=pk&0xFFFF;sumY+=pk>>16;}
  const centX=living.length>0?sumX/living.length:GS/2;
  const centY=living.length>0?sumY/living.length:GS/2;

  for(const pk of living){
    const x=pk&0xFFFF,y=pk>>16,i=y*GS+x;
    na[i]=age[i]+1;

    let die=na[i]>nma[i];
    if(cells[i]===CT.STEM&&nm[1][i]>1.8&&Math.random()<0.01) die=true;

    // Isolation pressure: cells with ≤1 living neighbor are exposed and die fast
    if(!die){
      let ln=0;
      for(let d=0;d<4;d++) if(cells[gi(x+DX[d],y+DY[d])]!==CT.EMPTY) ln++;
      if(ln===0) die=true;                          // completely isolated → instant death
      else if(ln===1 && Math.random()<0.08) die=true; // dangling tip → rapid cleanup
    }

    if(die){
      const recycleE=ne[i];
      const liveN=[];
      for(let d=0;d<4;d++){
        const ni=gi(x+DX[d],y+DY[d]);
        if(nc[ni]!==CT.EMPTY) liveN.push(ni);
      }
      if(liveN.length>0){const each=recycleE/liveN.length;for(const ni of liveN)ne[ni]+=each;}
      ne[i]=0;nc[i]=CT.EMPTY;na[i]=0;nma[i]=0;nm[1][i]+=0.06;deaths++;continue;
    }

    const myThresh=cells[i]===CT.STEM?DIV_THRESH:DIV_THRESH*DIFF_DIV_MULT;
    if(ne[i]>myThresh&&na[i]>DIV_COOLDOWN){
      let divided=false;

      if(nm[3][i]>0.06&&Math.random()<0.3){
        const ni=gi(x,y-1);
        if(nc[ni]===CT.EMPTY){
          const half=ne[i]*0.5;ne[i]=half;ne[ni]=half;
          nc[ni]=CT.STEM;na[i]=0;na[ni]=0;
          nma[ni]=assignMaxAge(CT.STEM);nm[0][ni]+=0.1;
          births++;divided=true;
        }
      }
      if(!divided){
        const order=[0,1,2,3];
        for(let d=3;d>0;d--){const j=Math.floor(Math.random()*(d+1));[order[d],order[j]]=[order[j],order[d]];}
        for(const d of order){
          const ni=gi(x+DX[d],y+DY[d]);
          if(nc[ni]===CT.EMPTY){
            const half=ne[i]*0.5;ne[i]=half;ne[ni]=half;
            nc[ni]=CT.STEM;na[i]=0;na[ni]=0;
            nma[ni]=assignMaxAge(CT.STEM);nm[0][ni]+=0.1;
            births++;break;
          }
        }
      }
    }

    const dxC=x-centX;
    const midline=Math.exp(-(dxC*dxC)/(2*14*14));
    nm[2][i]+=midline*0.01;
    const apFactor=Math.max(0,(centY-y)/(GS*0.1));
    nm[3][i]+=apFactor*0.01;

    const t=cells[i];
    if(t===CT.ECTO)nm[2][i]+=0.002;
    if(t===CT.NERVE){nm[2][i]+=0.012;nm[3][i]+=0.008;}
    if(t===CT.MESO||t===CT.MUSCLE)nm[3][i]+=0.004;
    if(t===CT.ENDO)nm[0][i]+=0.006;

    if(cells[i]===CT.STEM&&age[i]>DIFF_AGE){
      const d2=depth[i];
      const mid=nm[2][i],ap=nm[3][i];
      if(d2<=1){
        if(mid>0.18&&ap>0.18)nc[i]=CT.NERVE;
        else nc[i]=CT.ECTO;
      }else if(d2===2){
        nc[i]=CT.MESO;
      }else if(d2>=3&&d2<=5){
        nc[i]=CT.ENDO;
      }
      if(nc[i]!==CT.STEM&&nc[i]!==cells[i]){
        nma[i]=assignMaxAge(nc[i]);na[i]=0;
      }
    }

    if(cells[i]===CT.MESO&&age[i]>40){
      const act=nm[0][i],inh=nm[1][i];
      if(act>0.25&&inh>0.12){nc[i]=CT.MUSCLE;nma[i]=assignMaxAge(CT.MUSCLE);na[i]=0;}
      else if(act<0.08&&inh>0.18){nc[i]=CT.VESSEL;nma[i]=assignMaxAge(CT.VESSEL);na[i]=0;}
    }
  }

  let cc=0,tce=0;
  const tc=Array(NT).fill(0);
  for(let i=0;i<N;i++){tce+=ne[i];if(nc[i]!==CT.EMPTY){cc++;tc[nc[i]]++;}}
  return{cells:nc,energy:ne,morph:nm,age:na,maxAge:nma,
    tick:s.tick+1,cellCount:cc,typeCounts:tc,totalEnergy:tce,births,deaths};
}

function renderFrame(ctx,cvs,s,view,zoom,px,py){
  const W=cvs.width,H=cvs.height;
  const img=ctx.createImageData(W,H);
  const d=img.data;
  for(let p=0;p<d.length;p+=4){d[p]=6;d[p+1]=6;d[p+2]=10;d[p+3]=255;}
  const cs=zoom;
  const x0=Math.max(0,Math.floor(-px/cs));
  const y0=Math.max(0,Math.floor(-py/cs));
  const x1=Math.min(GS-1,Math.floor((W-px)/cs));
  const y1=Math.min(GS-1,Math.floor((H-py)/cs));
  const drawBorders=cs>=3;
  let depthField=null;
  if(view==="depth") depthField=computeDepth(s.cells);

  for(let gy=y0;gy<=y1;gy++) for(let gx=x0;gx<=x1;gx++){
    const idx=gy*GS+gx;
    let r=0,g=0,b=0,br2=0,bg2=0,bb2=0,show=false;
    if(view==="cells"){
      const t=s.cells[idx];
      if(t!==CT.EMPTY){show=true;
        const[cr,cg,cb]=COLORS[t];
        const eFrac=Math.min(1,s.energy[idx]/25);
        const ageFrac=Math.min(1,s.age[idx]/(SENESCENCE*0.8));
        const bright=0.35+0.55*eFrac+0.1*(1-ageFrac);
        r=cr*bright;g=cg*bright;b=cb*bright;
        if(drawBorders){[br2,bg2,bb2]=BORDER_COLORS[t];}
      }
    }else if(view==="depth"){
      if(s.cells[idx]!==CT.EMPTY&&depthField){show=true;
        const dv=depthField[idx];
        if(dv<=1){r=60;g=140;b=230;}
        else if(dv===2){r=60;g=200;b=100;}
        else if(dv<=4){r=230;g=200;b=40;}
        else if(dv<=6){r=230;g=100;b=30;}
        else{r=180;g=40;b=40;}
      }
    }else if(view==="activator"){
      const v=Math.min(1,s.morph[0][idx]*1.5);
      if(v>0.003){show=true;r=v*255;g=v*50;b=v*10;}
    }else if(view==="inhibitor"){
      const v=Math.min(1,s.morph[1][idx]*1.5);
      if(v>0.003){show=true;r=v*15;g=v*70;b=v*255;}
    }else if(view==="midline"){
      const v=Math.min(1,s.morph[2][idx]*2.5);
      if(v>0.003){show=true;r=v*180;g=v*60;b=v*240;}
    }else if(view==="ap"){
      const v=Math.min(1,s.morph[3][idx]*2);
      if(v>0.003){show=true;r=v*230;g=v*160;b=v*20;}
    }else if(view==="energy"){
      if(s.cells[idx]!==CT.EMPTY){show=true;
        const v=Math.min(1,s.energy[idx]/30);r=255*v;g=40+210*v;b=12;}
    }else if(view==="age"){
      if(s.cells[idx]!==CT.EMPTY){show=true;
        const v=Math.min(1,s.age[idx]/SENESCENCE);r=30+225*v;g=220-190*v;b=30;}
    }
    if(!show)continue;
    const pxS=Math.max(0,Math.floor(gx*cs+px));
    const pyS=Math.max(0,Math.floor(gy*cs+py));
    const pxE=Math.min(W,Math.floor((gx+1)*cs+px));
    const pyE=Math.min(H,Math.floor((gy+1)*cs+py));
    if(drawBorders&&view==="cells"){
      for(let py2=pyS;py2<pyE;py2++) for(let px2=pxS;px2<pxE;px2++){
        const pi=(py2*W+px2)*4;
        const edge=(px2===pxS||px2===pxE-1||py2===pyS||py2===pyE-1);
        if(edge){d[pi]=br2;d[pi+1]=bg2;d[pi+2]=bb2;}
        else{d[pi]=r;d[pi+1]=g;d[pi+2]=b;}}
    }else{
      for(let py2=pyS;py2<pyE;py2++) for(let px2=pxS;px2<pxE;px2++){
        const pi=(py2*W+px2)*4;d[pi]=r;d[pi+1]=g;d[pi+2]=b;}}
  }
  ctx.putImageData(img,0,0);
}

const Btn=({children,onClick,active,disabled,c})=>(
  <button onClick={onClick} disabled={disabled} style={{
    background:active?"#1a182c":"#111115",
    border:active?`1px solid ${c||"#5b4fc7"}`:"1px solid #222230",
    color:active?(c||"#c8b4ff"):disabled?"#303038":"#a0a095",
    padding:"5px 9px",borderRadius:4,fontSize:10,fontWeight:600,
    letterSpacing:1,cursor:disabled?"not-allowed":"pointer",
    fontFamily:"inherit",transition:"all 0.12s"}}>{children}</button>);
const Row=({l,v,w:warn,c:color})=>(
  <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
    <span style={{color:"#504f4a"}}>{l}</span>
    <span style={{color:warn?"#f59e0b":color||"#a0a095",fontWeight:600}}>{v}</span>
  </div>);
const Sec=({t,children})=>(
  <div><div style={{fontSize:8,letterSpacing:2,color:"#454540",marginBottom:5}}>{t}</div>{children}</div>);

export default function EmbryoEngine(){
  const cvsRef=useRef(null);const sRef=useRef(null);
  const runRef=useRef(false);const animRef=useRef(null);
  const seedCount=29;
  const initTC=()=>{const t=Array(NT).fill(0);t[1]=seedCount;return t;};
  const[ui,setUi]=useState({tick:0,cc:seedCount,tc:initTC(),te:TOTAL_E,b:0,d:0});
  const[running,setRunning]=useState(false);
  const[speed,setSpeed]=useState(1);
  const[view,setView]=useState("cells");
  const[zoom,setZoom]=useState(4);
  const panRef=useRef({x:0,y:0});
  const[intro,setIntro]=useState(true);
  const cumRef=useRef({b:0,d:0});

  useEffect(()=>{
    sRef.current=create();
    const c=cvsRef.current;
    if(c){c.width=c.offsetWidth;c.height=c.offsetHeight;
      panRef.current={x:c.width/2-(GS/2)*zoom,y:c.height/2-(GS/2)*zoom};
      renderFrame(c.getContext("2d"),c,sRef.current,view,zoom,panRef.current.x,panRef.current.y);}
  },[]);

  const doRender=useCallback(()=>{
    const c=cvsRef.current;
    if(!c||!sRef.current)return;
    renderFrame(c.getContext("2d"),c,sRef.current,view,zoom,panRef.current.x,panRef.current.y);
  },[view,zoom]);

  useEffect(()=>{
    if(!running)return;runRef.current=true;
    const loop=()=>{if(!runRef.current)return;
      for(let i=0;i<speed;i++){sRef.current=simStep(sRef.current);
        cumRef.current.b+=sRef.current.births;cumRef.current.d+=sRef.current.deaths;}
      const ss=sRef.current;
      setUi({tick:ss.tick,cc:ss.cellCount,tc:[...ss.typeCounts],
        te:ss.totalEnergy,b:cumRef.current.b,d:cumRef.current.d});
      doRender();animRef.current=requestAnimationFrame(loop);};
    animRef.current=requestAnimationFrame(loop);
    return()=>{runRef.current=false;if(animRef.current)cancelAnimationFrame(animRef.current);};
  },[running,speed,doRender]);

  useEffect(()=>{doRender();},[view,zoom,doRender]);

  const reset=()=>{setRunning(false);runRef.current=false;
    sRef.current=create();cumRef.current={b:0,d:0};
    setUi({tick:0,cc:seedCount,tc:initTC(),te:TOTAL_E,b:0,d:0});setIntro(true);
    const c=cvsRef.current;
    if(c)panRef.current={x:c.width/2-(GS/2)*zoom,y:c.height/2-(GS/2)*zoom};
    setTimeout(doRender,30);};

  const doStep=()=>{if(!sRef.current)return;
    sRef.current=simStep(sRef.current);
    cumRef.current.b+=sRef.current.births;cumRef.current.d+=sRef.current.deaths;
    const ss=sRef.current;
    setUi({tick:ss.tick,cc:ss.cellCount,tc:[...ss.typeCounts],
      te:ss.totalEnergy,b:cumRef.current.b,d:cumRef.current.d});doRender();};

  const dragRef=useRef(null);
  const onMD=e=>{dragRef.current={x:e.clientX-panRef.current.x,y:e.clientY-panRef.current.y};};
  const onMM=e=>{if(!dragRef.current)return;panRef.current={x:e.clientX-dragRef.current.x,y:e.clientY-dragRef.current.y};doRender();};
  const onMU=()=>{dragRef.current=null;};
  const onW=e=>{e.preventDefault();setZoom(z=>Math.max(1,Math.min(14,z+(e.deltaY>0?-0.5:0.5))));};

  const ePct=((ui.te/TOTAL_E)*100).toFixed(1);
  const avgE=ui.cc>0?(ui.te/ui.cc).toFixed(1):"—";

  const views=[
    {id:"cells",l:"Cells",d:"Germ layers + brightness"},
    {id:"depth",l:"Depth",d:"BFS distance to surface"},
    {id:"energy",l:"Energy",d:"Per-cell reserves"},
    {id:"age",l:"Age",d:"Green→red: young→old"},
    {id:"midline",l:"Midline",d:"Bilateral symmetry signal"},
    {id:"ap",l:"A-P Axis",d:"Anterior-posterior"},
    {id:"activator",l:"Activator",d:"Turing short-range"},
    {id:"inhibitor",l:"Inhibitor",d:"Turing long-range"},
  ];

  return(
    <div style={{width:"100%",height:"100vh",background:"#08080c",color:"#c0bcb0",
      fontFamily:"'JetBrains Mono','Fira Code','SF Mono',monospace",
      display:"flex",flexDirection:"column",overflow:"hidden",userSelect:"none"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
        padding:"7px 13px",borderBottom:"1px solid #1a1a22",background:"#0a0a10",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <div style={{width:8,height:8,borderRadius:"50%",
            background:running?"#4ade80":"#f59e0b",
            boxShadow:running?"0 0 6px #4ade80":"0 0 6px #f59e0b"}}/>
          <span style={{fontSize:12,fontWeight:700,letterSpacing:2.5,color:"#e0dcd0"}}>EMBRYO ENGINE</span>
          <span style={{fontSize:8,color:"#3e3e3a",letterSpacing:1.5}}>v0.9 · GERM LAYERS</span>
        </div>
        <span style={{fontSize:9,color:"#3e3e3a"}}>
          T{ui.tick} · {ui.cc.toLocaleString()} cells · +{ui.b.toLocaleString()}/-{ui.d.toLocaleString()}
        </span>
      </div>
      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{width:208,borderRight:"1px solid #1a1a22",padding:"10px 10px",
          display:"flex",flexDirection:"column",gap:8,overflowY:"auto",flexShrink:0,
          background:"#09090e",fontSize:10}}>
          <Sec t="CONTROLS">
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              <Btn onClick={()=>{setRunning(!running);setIntro(false);}} active={running} c="#4ade80">
                {running?"⏸ PAUSE":"▶ RUN"}</Btn>
              <Btn onClick={()=>{doStep();setIntro(false);}} disabled={running}>⏭ STEP</Btn>
              <Btn onClick={reset}>↺ RESET</Btn>
            </div>
          </Sec>
          <Sec t={`SPEED: ${speed} t/f`}>
            <input type="range" min={1} max={6} value={speed}
              onChange={e=>setSpeed(+e.target.value)} style={{width:"100%",accentColor:"#7c6ef5"}}/>
          </Sec>
          <Sec t={`ZOOM: ${zoom.toFixed(1)}x`}>
            <input type="range" min={1} max={14} step={0.5} value={zoom}
              onChange={e=>setZoom(+e.target.value)} style={{width:"100%",accentColor:"#7c6ef5"}}/>
          </Sec>
          <Sec t="VIEW">
            <div style={{display:"flex",flexDirection:"column",gap:2}}>
              {views.map(v=>(
                <button key={v.id} onClick={()=>setView(v.id)} style={{
                  background:view===v.id?"#18162a":"transparent",
                  border:view===v.id?"1px solid #34305a":"1px solid transparent",
                  color:view===v.id?"#bfb0ff":"#555550",
                  padding:"3px 6px",borderRadius:3,fontSize:10,letterSpacing:1,
                  cursor:"pointer",textAlign:"left",transition:"all 0.1s",
                }}>{v.l}{view===v.id?<span style={{fontSize:8,color:"#38383a",marginLeft:5}}>{v.d}</span>:null}</button>
              ))}
            </div>
          </Sec>
          <div style={{borderTop:"1px solid #16161e",paddingTop:7}}>
            <div style={{fontSize:8,letterSpacing:2,color:"#454540",marginBottom:5}}>ENERGY</div>
            <Row l="Total" v={ui.te.toFixed(0)}/>
            <Row l="Conserved" v={`${ePct}%`} w={+ePct<95}/>
            <Row l="Avg/Cell" v={avgE}/>
            <div style={{marginTop:3,height:4,borderRadius:2,background:"#16161e",overflow:"hidden"}}>
              <div style={{width:`${Math.min(100,+ePct)}%`,height:"100%",
                background:+ePct>95?"#4ade80":+ePct>85?"#f59e0b":"#ef4444",transition:"width 0.3s"}}/>
            </div>
          </div>
          <div style={{borderTop:"1px solid #16161e",paddingTop:7}}>
            <div style={{fontSize:8,letterSpacing:2,color:"#454540",marginBottom:5}}>TISSUE LAYERS</div>
            {ui.tc.map((c,i)=>{
              if(i===0||c===0)return null;
              const[cr,cg,cb]=COLORS[i];
              const pct=ui.cc>0?((c/ui.cc)*100).toFixed(0):0;
              return <div key={i} style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                <div style={{width:7,height:7,borderRadius:2,background:`rgb(${cr},${cg},${cb})`,flexShrink:0}}/>
                <span style={{color:"#757570",flex:1,fontSize:9}}>{NAMES[i]}</span>
                <span style={{color:`rgb(${cr},${cg},${cb})`,fontWeight:600,fontSize:9}}>{c.toLocaleString()}</span>
                <span style={{color:"#38383a",fontSize:8,width:26,textAlign:"right"}}>{pct}%</span>
              </div>;
            })}
          </div>
          <div style={{borderTop:"1px solid #16161e",paddingTop:7}}>
            <div style={{fontSize:8,letterSpacing:2,color:"#454540",marginBottom:5}}>VITALS</div>
            <Row l="Born" v={ui.b.toLocaleString()} c="#4ade80"/>
            <Row l="Died" v={ui.d.toLocaleString()} c="#ef7070"/>
            <Row l="Net" v={(ui.b-ui.d).toLocaleString()}/>
          </div>
          <div style={{borderTop:"1px solid #16161e",paddingTop:7,marginTop:"auto"}}>
            <div style={{fontSize:7,lineHeight:1.5,color:"#333330"}}>
              All daughters born STEM. BFS depth → fate.
              Isolated cells die fast (tissue compaction).
              Zero sinks. 100% recycle. Drag · scroll.
            </div>
          </div>
        </div>
        <div style={{flex:1,position:"relative"}}>
          <canvas ref={cvsRef} style={{width:"100%",height:"100%",display:"block",cursor:"grab"}}
            width={900} height={700}
            onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU} onWheel={onW}/>
          {intro&&ui.tick===0&&(
            <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",
              background:"rgba(6,6,10,0.96)",border:"1px solid #252535",borderRadius:8,
              padding:"20px 24px",maxWidth:460,textAlign:"center"}}>
              <div style={{fontSize:14,fontWeight:700,color:"#e0dcd0",marginBottom:6,letterSpacing:1.5}}>
                EMBRYO ENGINE v0.9</div>
              <p style={{fontSize:11,lineHeight:1.7,color:"#8a8878",margin:"0 0 8px"}}>
                Every daughter cell is born as <b style={{color:"rgb(215,205,165)"}}>stem</b>.
                It differentiates based on how deep it sits in the tissue:</p>
              <div style={{fontSize:10,lineHeight:1.9,color:"#7a7870",textAlign:"left",margin:"0 auto 12px",maxWidth:340}}>
                <span style={{color:"rgb(65,150,225)"}}>■</span> <b>Surface</b> (depth 1) → Ectoderm<br/>
                <span style={{color:"rgb(145,72,235)"}}>■</span> <b>Surface + midline + AP</b> → Neural<br/>
                <span style={{color:"rgb(220,65,65)"}}>■</span> <b>Sub-surface</b> (depth 2) → Mesoderm<br/>
                <span style={{color:"rgb(240,180,45)"}}>■</span> <b>Mid-depth</b> (3-5) → Endoderm<br/>
                <span style={{color:"rgb(215,205,165)"}}>■</span> <b>Deep core</b> (6+) → Stem niche
              </div>
              <p style={{fontSize:9,color:"#484844",lineHeight:1.5,margin:0}}>
                Try <b>Depth</b> view to see the layering directly. Press <b style={{color:"#a8e6a0"}}>RUN</b>.</p>
            </div>
          )}
          <div style={{position:"absolute",bottom:7,right:7,
            background:"rgba(6,6,10,0.9)",border:"1px solid #1a1a22",
            borderRadius:4,padding:"5px 9px",display:"flex",gap:7,flexWrap:"wrap"}}>
            {COLORS.slice(1).map((c,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:3,fontSize:8}}>
                <div style={{width:6,height:6,borderRadius:2,background:`rgb(${c[0]},${c[1]},${c[2]})`}}/>
                <span style={{color:"#555550"}}>{NAMES[i+1]}</span>
              </div>
            ))}
          </div>
          {ui.tick>0&&ui.tick<300&&(
            <div style={{position:"absolute",top:8,left:"50%",transform:"translateX(-50%)",
              background:"rgba(6,6,10,0.85)",border:"1px solid #1a1a22",
              borderRadius:4,padding:"3px 10px",fontSize:9,color:"#555550",letterSpacing:1}}>
              {ui.tick<30?"CLEAVAGE":ui.tick<100?"BLASTULATION":ui.tick<200?"GASTRULATION":"ORGANOGENESIS"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
