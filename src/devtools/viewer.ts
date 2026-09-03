import type { DependencyGraphSnapshot } from "./graph.js";

export type DependencyGraphViewerOptions = {
  title?: string;
};

/** Render a dependency graph as an offline, self-contained interactive HTML document. */
export function renderDependencyGraphHtml(
  snapshot: DependencyGraphSnapshot,
  options: DependencyGraphViewerOptions = {},
): string {
  const title = escapeHtml(options.title ?? "DI runtime graph");
  const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root { color-scheme: dark; --bg:#08111f; --panel:rgba(15,28,49,.88); --panel-2:#12233b; --text:#eef5ff; --muted:#91a5c1; --line:#2a4668; --cyan:#6ee7f9; --violet:#a78bfa; --orange:#fbbf75; --red:#fb7185; --green:#6ee7b7; }
* { box-sizing:border-box; } body { margin:0; min-height:100vh; overflow:hidden; color:var(--text); background:radial-gradient(circle at 20% 0%,#19335b 0,transparent 38%),linear-gradient(135deg,#07101d,#0c1729 62%,#101b31); font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.app { height:100vh; display:grid; grid-template-rows:auto 1fr; } header { z-index:2; display:flex; align-items:center; gap:18px; padding:18px 24px; background:rgba(5,12,24,.72); border-bottom:1px solid rgba(145,165,193,.16); backdrop-filter:blur(18px); } h1 { margin:0; font-size:18px; letter-spacing:.01em; } .subtitle { color:var(--muted); font-size:12px; } .tools { margin-left:auto; display:flex; align-items:center; gap:9px; } input,button { border:1px solid var(--line); border-radius:10px; background:rgba(18,35,59,.8); color:var(--text); padding:9px 11px; font:inherit; } input { width:230px; outline:none; } input:focus { border-color:var(--cyan); box-shadow:0 0 0 3px rgba(110,231,249,.12); } button { cursor:pointer; } button:hover { border-color:var(--cyan); } label { color:var(--muted); font-size:12px; white-space:nowrap; }
.main { min-height:0; display:grid; grid-template-columns:minmax(0,1fr) 310px; } .stage { position:relative; min-width:0; overflow:hidden; } #graph { width:100%; height:100%; cursor:grab; } #graph:active { cursor:grabbing; } .hud { position:absolute; left:18px; bottom:16px; display:flex; gap:8px; flex-wrap:wrap; pointer-events:none; } .pill { padding:6px 9px; border:1px solid rgba(145,165,193,.2); border-radius:999px; background:rgba(8,17,31,.74); color:var(--muted); font-size:11px; backdrop-filter:blur(10px); } .legend { position:absolute; right:18px; bottom:16px; display:flex; gap:12px; color:var(--muted); font-size:11px; } .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; background:var(--cyan); } .dot.cycle { background:var(--red); } .dot.async { background:var(--violet); }
aside { min-height:0; overflow:auto; padding:24px 20px; background:var(--panel); border-left:1px solid rgba(145,165,193,.16); box-shadow:-20px 0 50px rgba(0,0,0,.12); } .eyebrow { color:var(--cyan); font-size:10px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; } .empty { color:var(--muted); margin-top:20px; } .service-title { margin:6px 0 2px; font-size:22px; overflow-wrap:anywhere; } .service-key { color:var(--orange); font-size:12px; } .stats { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:18px 0; } .stat { padding:11px; background:rgba(18,35,59,.65); border:1px solid rgba(145,165,193,.12); border-radius:12px; } .stat strong { display:block; font-size:18px; } .stat span { color:var(--muted); font-size:11px; } .section { margin-top:20px; } .section h2 { margin:0 0 8px; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.09em; } .related { display:grid; gap:7px; } .related button { width:100%; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
svg .edge { fill:none; stroke:rgba(145,165,193,.42); stroke-width:1.5; marker-end:url(#arrow); transition:stroke .18s,stroke-width .18s,opacity .18s; } svg .edge.hot { stroke:var(--cyan); stroke-width:3; } svg .edge.dim { opacity:.12; } svg .node { cursor:pointer; transition:opacity .18s; } svg .node.dim { opacity:.15; } svg .node rect { fill:#10223a; stroke:#37618d; stroke-width:1.5; filter:drop-shadow(0 7px 14px rgba(0,0,0,.22)); } svg .node:hover rect, svg .node.selected rect { stroke:var(--cyan); stroke-width:2.5; } svg .node.cycle rect { stroke:var(--red); } svg .node.async rect { stroke:var(--violet); } svg text { user-select:none; pointer-events:none; } svg .name { fill:var(--text); font-weight:650; } svg .meta { fill:var(--muted); font-size:10px; } .no-data { position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); text-align:center; padding:40px; }
@media (max-width: 850px) { header { padding:14px; flex-wrap:wrap; gap:8px; } .tools { width:100%; margin-left:0; } input { flex:1; min-width:0; } .main { grid-template-columns:1fr; grid-template-rows:minmax(0,1fr) 250px; } aside { border-left:0; border-top:1px solid rgba(145,165,193,.16); } }
</style>
</head>
<body>
<div class="app">
<header><div><h1>${title}</h1><div class="subtitle">Observed runtime resolutions · drag to pan · wheel to zoom · click a node for details</div></div><div class="tools"><input id="search" placeholder="Search services…" aria-label="Search services" /><label><input id="hotOnly" type="checkbox" /> hot path</label><button id="reset" type="button">Reset view</button></div></header>
<div class="main"><section class="stage"><svg id="graph" role="img" aria-label="Dependency graph"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#6ee7f9" /></marker></defs><g id="viewport"><g id="edges"></g><g id="nodes"></g></g></svg><div id="noData" class="no-data" hidden>No runtime resolutions captured yet.<br/>Attach <code>RuntimeDependencyGraph</code> and resolve your services first.</div><div class="hud" id="hud"></div><div class="legend"><span><i class="dot"></i>resolved</span><span><i class="dot async"></i>async</span><span><i class="dot cycle"></i>cycle</span></div></section><aside id="details"><div class="eyebrow">Runtime inspector</div><div class="empty">Select a service node to inspect its observed dependencies.</div></aside></div>
</div>
<script>
const DATA = ${data};
const svg = document.getElementById('graph'), viewport = document.getElementById('viewport'), edgeLayer = document.getElementById('edges'), nodeLayer = document.getElementById('nodes'), details = document.getElementById('details'), search = document.getElementById('search'), hotOnly = document.getElementById('hotOnly'), hud = document.getElementById('hud'), noData = document.getElementById('noData');
const ns='http://www.w3.org/2000/svg'; let selected=null, transform={x:0,y:0,k:1}, dragging=false, start={x:0,y:0};
const nodeById=new Map(DATA.nodes.map(n=>[n.id,n])), incoming=new Map(), outgoing=new Map(); DATA.nodes.forEach(n=>{incoming.set(n.id,[]);outgoing.set(n.id,[])}); DATA.edges.forEach(e=>{incoming.get(e.target)?.push(e);outgoing.get(e.source)?.push(e)});
function layout(){const rank=new Map(), queue=DATA.roots.length?DATA.roots:[...DATA.nodes.map(n=>n.id)]; queue.forEach(id=>rank.set(id,0)); for(let pass=0;pass<DATA.nodes.length+2;pass++) DATA.edges.forEach(e=>{rank.set(e.target,Math.max(rank.get(e.target)||0,(rank.get(e.source)||0)+1))}); const groups=new Map(); DATA.nodes.forEach(n=>{const r=rank.get(n.id)||0; if(!groups.has(r))groups.set(r,[]);groups.get(r).push(n)}); const pos=new Map(); [...groups.entries()].forEach(([r,items])=>items.forEach((n,i)=>pos.set(n.id,{x:140+r*235,y:100+i*105-(items.length-1)*52}))); return pos}
const positions=layout(); function el(tag,attrs){const x=document.createElementNS(ns,tag);Object.entries(attrs||{}).forEach(([k,v])=>x.setAttribute(k,v));return x}
function truncate(s,max=24){return s.length>max?s.slice(0,max-1)+'…':s} function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(){edgeLayer.replaceChildren();nodeLayer.replaceChildren(); const q=search.value.toLowerCase().trim(), hot=hotOnly.checked; DATA.edges.forEach(e=>{const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b)return;const p=el('path',{class:'edge',d:'M '+(a.x+170)+' '+a.y+' C '+(a.x+205)+' '+a.y+', '+(b.x-35)+' '+b.y+', '+b.x+' '+b.y,'data-edge':e.id});edgeLayer.append(p)}); DATA.nodes.forEach(n=>{const p=positions.get(n.id);if(!p)return;const g=el('g',{class:'node'+(n.cycle?' cycle':'')+(n.asyncResolutions?' async':''),transform:'translate('+p.x+','+(p.y-28)+')','data-id':n.id});const rect=el('rect',{width:170,height:56,rx:12});const name=el('text',{class:'name',x:12,y:22});name.textContent=truncate(n.label);const meta=el('text',{class:'meta',x:12,y:41});meta.textContent=(n.lifetime||'observed')+' · '+n.resolutions+'×'+(n.asyncResolutions?' · async':'');g.append(rect,name,meta);g.addEventListener('click',()=>select(n.id));nodeLayer.append(g)});applyFilter(q,hot);hud.innerHTML='<span class="pill">'+DATA.nodes.length+' services</span><span class="pill">'+DATA.edges.length+' observed edges</span><span class="pill">'+DATA.cycles.length+' cycles</span><span class="pill">captured '+new Date(DATA.capturedAt).toLocaleString()+'</span>';noData.hidden=DATA.nodes.length>0; applyTransform()}
function applyFilter(q,hot){const matches=new Set(DATA.nodes.filter(n=>!q||n.label.toLowerCase().includes(q)||(n.key||'').toLowerCase().includes(q)).map(n=>n.id));document.querySelectorAll('.node').forEach(g=>g.classList.toggle('dim',!matches.has(g.dataset.id)||(hot&&!nodeById.get(g.dataset.id).resolutions)));document.querySelectorAll('.edge').forEach(p=>{const e=DATA.edges.find(x=>x.id===p.dataset.edge);p.classList.toggle('dim',!matches.has(e.source)||!matches.has(e.target));p.classList.toggle('hot',selected&&(e.source===selected||e.target===selected))})}
function select(id){selected=id;document.querySelectorAll('.node').forEach(g=>g.classList.toggle('selected',g.dataset.id===id));const n=nodeById.get(id);if(!n)return;const connected=[...incoming.get(id),...outgoing.get(id)].map(e=>nodeById.get(e.source===id?e.target:e.source));details.innerHTML='<div class="eyebrow">Service node</div><div class="service-title">'+esc(n.label)+'</div>'+(n.key?'<div class="service-key">key · '+esc(n.key)+'</div>':'')+'<div class="stats"><div class="stat"><strong>'+n.resolutions+'</strong><span>resolutions</span></div><div class="stat"><strong>'+n.asyncResolutions+'</strong><span>async</span></div><div class="stat"><strong>'+outgoing.get(id).length+'</strong><span>dependencies</span></div><div class="stat"><strong>'+incoming.get(id).length+'</strong><span>dependents</span></div></div>'+(n.cycle?'<div class="section"><div class="pill" style="color:var(--red)">Cycle detected in observed path</div></div>':'')+'<div class="section"><h2>Observed dependencies</h2><div class="related">'+(connected.length?connected.map(x=>'<button data-related="'+x.id+'">'+esc(x.label)+'</button>').join(''):'<span class="empty">No adjacent runtime edges.</span>')+'</div></div>';details.querySelectorAll('[data-related]').forEach(b=>b.addEventListener('click',()=>select(b.dataset.related)));applyFilter(search.value.toLowerCase().trim(),hotOnly.checked)}
function applyTransform(){viewport.setAttribute('transform','translate('+transform.x+','+transform.y+') scale('+transform.k+')')}
svg.addEventListener('pointerdown',e=>{dragging=true;start={x:e.clientX-transform.x,y:e.clientY-transform.y};svg.setPointerCapture(e.pointerId)});svg.addEventListener('pointermove',e=>{if(dragging){transform.x=e.clientX-start.x;transform.y=e.clientY-start.y;applyTransform()}});svg.addEventListener('pointerup',()=>dragging=false);svg.addEventListener('wheel',e=>{e.preventDefault();transform.k=Math.max(.35,Math.min(2.5,transform.k*(e.deltaY<0?1.1:.9)));applyTransform()},{passive:false}); search.addEventListener('input',()=>applyFilter(search.value.toLowerCase().trim(),hotOnly.checked));hotOnly.addEventListener('change',()=>applyFilter(search.value.toLowerCase().trim(),hotOnly.checked));document.getElementById('reset').addEventListener('click',()=>{transform={x:0,y:0,k:1};applyTransform()});render();
</script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
