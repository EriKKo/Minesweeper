// Generate the "4x4 opening with a corner mine" starting-position family and store a ~200 sample.
//
// The 4x4 rectangle has one corner as a (covered, deduced — not pre-flagged) mine; the far interior always
// has a 0-cell, so it floods like a real cascade. We enumerate every surrounding ring-mine layout, dedup by
// the revealed-clue tuple, and for each distinct opening fully analyze the static deductions: TOTAL
// difficulty (sum of every move's complexity) + MAX (hardest single move). Forced safe/mine ring cells come
// from the exact brute-force closure over the bucket (ground truth, not analyzer-limited).
//
// We keep the single hardest opening plus an even random sample across difficulty bands (~200 total), tagged
// variant="corner4", size=4 — so the admin Start-positions page can filter them apart from the 3x3 cascades.
const BL = require("../src/common/BoardLogic");
const csp = require("../src/server/CSPSolver");
const db = require("../src/server/db");
const MINE = BL.MINE, KNOWN = BL.KNOWN, UNKNOWN = BL.UNKNOWN;
function popcount(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0f0f0f0f)*0x01010101)>>>24; }
function scoreToRating(x){ return Math.max(0, Math.round(240 * (x - 0.5))); }

const H=4,W=4,BR=6,BC=6,r0=1,c0=1,cR=1,cC=1;
const inRect=(r,c)=> r>=r0&&r<r0+H&&c>=c0&&c<c0+W;
const ringCells=[]; const ringIdx={};
for(let r=0;r<BR;r++)for(let c=0;c<BC;c++) if(!inRect(r,c)){ ringIdx[r+","+c]=ringCells.length; ringCells.push([r,c]); }
const ring=ringCells.length; // 20
// revealed cells (4x4 minus the corner), row-major; meta carries ring-neighbour mask + corner adjacency
const cells=[]; // every 4x4 cell row-major (incl corner) for the pattern string
for(let r=r0;r<r0+H;r++)for(let c=c0;c<c0+W;c++) cells.push([r,c]);
const meta=[];
for(const [r,c] of cells){
  if(r===cR&&c===cC) continue;
  let mask=0,adjM=false,touches=0;
  for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){ if(!dr&&!dc)continue; const nr=r+dr,nc=c+dc;
    if(nr===cR&&nc===cC){adjM=true;continue;}
    if(ringIdx[nr+","+nc]!==undefined){mask|=(1<<ringIdx[nr+","+nc]);touches++;} }
  meta.push({r,c,mask,adjM,boundary:touches>0});
}
const bnd=meta.filter(m=>m.boundary);

// Enumerate: bucket by boundary-clue tuple, track solution count + per-ring mine occurrences (for forced masks).
const buckets=new Map(); const total=1<<ring;
for(let a=0;a<total;a++){
  let k=0,bad=false;
  for(let i=0;i<bnd.length;i++){ const v=popcount(a&bnd[i].mask)+(bnd[i].adjM?1:0); if(v===0){bad=true;break;} k=k*9+v; }
  if(bad) continue;
  let b=buckets.get(k);
  if(!b){ b={bClues:bnd.map(m=>popcount(a&m.mask)+(m.adjM?1:0)), sol:0, orCounts:new Int32Array(ring)}; buckets.set(k,b); }
  b.sol++;
  for(let bit=0;bit<ring;bit++) if(a&(1<<bit)) b.orCounts[bit]++;
}
console.log("unique openings:", buckets.size);

// Analyze each opening: full-solve total/max difficulty + first move; forced masks from the brute-force closure.
const records=[]; let n=0;
for(const b of buckets.values()){
  const board=[],state=[];
  for(let r=0;r<BR;r++){board.push(new Array(BC).fill(0));state.push(new Array(BC).fill(UNKNOWN));}
  let bi=0;
  for(const m of meta){ state[m.r][m.c]=KNOWN; board[m.r][m.c]= m.boundary?b.bClues[bi++]:(m.adjM?1:0); }
  state[cR][cC]=UNKNOWN; board[cR][cC]=MINE; // corner: covered, solver deduces it
  const res=csp.analyzeBoard(board,state,{});
  if(!res.moves.length) continue;
  let tot=0,mx=0; for(const mv of res.moves){ tot+=mv.complexity; if(mv.complexity>mx)mx=mv.complexity; }
  // forced ring masks from the closure: bit set in EVERY solution = forced mine; in NONE = forced safe
  let safeMask=0,mineMask=0,fSafe=0,fMine=0;
  for(let bit=0;bit<ring;bit++){ if(b.orCounts[bit]===0){safeMask|=(1<<bit);fSafe++;} else if(b.orCounts[bit]===b.sol){mineMask|=(1<<bit);fMine++;} }
  // pattern string: 16 row-major 4x4 cells, corner = "M", others = clue value
  const clueAt={}; bi=0; for(const m of meta) clueAt[m.r+","+m.c]= m.boundary?b.bClues[bi++]:(m.adjM?1:0);
  const pattern = cells.map(([r,c])=> (r===cR&&c===cC)?"M":String(clueAt[r+","+c])).join(".");
  // analyzeBoard returns BUNDLED moves (revealed/flagged arrays, no .action) — derive the first action
  const m0=res.moves[0];
  const firstAction = (m0.revealed.length && m0.flagged.length) ? "case" : (m0.flagged.length ? "flag" : "reveal");
  records.push({ pattern, sol:b.sol, fSafe, fMine, safeMask, mineMask,
    firstAction: firstAction, firstComplexity:+m0.complexity.toFixed(3),
    total:+tot.toFixed(3), max:+mx.toFixed(3) });
  if(++n % 20000 === 0) console.log("...analyzed", n);
}
console.log("analyzed:", records.length);

// Sample ~200: always the single hardest (by max, tie-break total), plus an even random sample per band.
const TARGET=200;
let hardest=records[0]; for(const r of records){ if(r.max>hardest.max || (r.max===hardest.max && r.total>hardest.total)) hardest=r; }
const byBand=new Map();
for(const r of records){ const band=Math.floor(r.max); if(!byBand.has(band)) byBand.set(band,[]); byBand.get(band).push(r); }
const bands=[...byBand.keys()].sort((a,b)=>a-b);
const perBand=Math.ceil(TARGET/bands.length);
const chosen=new Set(), sample=[];
function add(r){ if(!chosen.has(r.pattern)){ chosen.add(r.pattern); sample.push(r); } }
add(hardest);
for(const band of bands){
  const pool=byBand.get(band).slice();
  for(let i=pool.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const t=pool[i];pool[i]=pool[j];pool[j]=t; }
  for(let i=0;i<pool.length && i<perBand;i++) add(pool[i]);
}
console.log("sampled:", sample.length, "(bands:", bands.join(","), "| hardest max", hardest.max, "total", hardest.total, ")");

// Store: clear any prior corner4 rows, then insert the sample.
db.clearStartingPositionsVariant("corner4");
let inserted=0;
for(const r of sample){
  const id=db.insertStartingPosition({
    size:4, pattern:r.pattern, solutions:r.sol, forcedSafe:r.fSafe, forcedMine:r.fMine,
    forcedSafeMask:r.safeMask, forcedMineMask:r.mineMask, isPrime:0, removableMask:0,
    firstAction:r.firstAction, firstComplexity:r.firstComplexity, rating:scoreToRating(r.max),
    variant:"corner4", totalComplexity:r.total, maxComplexity:r.max
  });
  if(id) inserted++;
}
console.log("inserted corner4 starting positions:", inserted);
