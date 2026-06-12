// Fast "scout" for genuinely-hard 4x4 corner-mine openings — reports only, writes nothing.
//
// Goal: find openings that are FULLY SOLVABLE but REQUIRE case analysis (the good/hard ones), cheaply.
// Three cheap filters instead of full-analyzing all 76k openings:
//   1. Sparse-ring enumeration: only enumerate ring layouts with <= MAX_RING_MINES mines. Interesting
//      case-analysis puzzles have low clues (few ring mines); dense rings are over-constrained/chaotic.
//   2. Capped "simple-logic" pre-pass (trivial+subset+cascade, NO case/enum): classify each opening by
//      how many safe cells simple logic leaves covered (`residue`):
//        residue == 0            -> solvable by simple logic -> too easy, skip the full solver.
//        residue  > RESIDUE_CAP  -> big ambiguous frontier   -> likely hopeless, skip the full solver.
//        0 < residue <= cap      -> CANDIDATE: full-analyze (this is where one case-split closes it).
//   3. Keep "gems": full solve has solved===true AND used at least one case-split move.
//
// Tunables: MAX_RING_MINES (default 7), RESIDUE_CAP (default 8). e.g. MAX_RING_MINES=8 node scripts/scout-corner-positions.js
const BL = require("../src/common/BoardLogic");
const csp = require("../src/server/CSPSolver");
const MINE = BL.MINE, KNOWN = BL.KNOWN, UNKNOWN = BL.UNKNOWN;
const popcount = BL.popcount;

const MAX_RING_MINES = parseInt(process.env.MAX_RING_MINES || "7", 10);
const RESIDUE_CAP = parseInt(process.env.RESIDUE_CAP || "8", 10);
const EXAMPLE = "M.2.1.1.2.1.0.1.2.0.0.1.2.1.1.1";

// Block size (env H/W). The block is fully revealed except one corner mine; the surrounding border is the
// covered ring. Bigger blocks have more interior room for genuine case-analysis structure.
const H=parseInt(process.env.H||"4",10), W=parseInt(process.env.W||"4",10);
const BR=H+2, BC=W+2, r0=1,c0=1,cR=1,cC=1;
const inRect=(r,c)=> r>=r0&&r<r0+H&&c>=c0&&c<c0+W;
const ringIdx={}; let ring=0;
for(let r=0;r<BR;r++)for(let c=0;c<BC;c++) if(!inRect(r,c)){ ringIdx[r+","+c]=ring++; }
const cells=[]; for(let r=r0;r<r0+H;r++)for(let c=c0;c<c0+W;c++) cells.push([r,c]);
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

// 1. Sparse enumeration: bucket by boundary-clue tuple, keep first (lex-smallest) layout + sol count.
const t0=Date.now();
const buckets=new Map(); const total=1<<ring; let swept=0;
for(let a=0;a<total;a++){
  if(popcount(a) > MAX_RING_MINES) continue;
  swept++;
  let k=0,bad=false;
  for(let i=0;i<bnd.length;i++){ const v=popcount(a&bnd[i].mask)+(bnd[i].adjM?1:0); if(v===0){bad=true;break;} k=k*9+v; }
  if(bad) continue;
  let b=buckets.get(k);
  if(!b){ b={bClues:bnd.map(m=>popcount(a&m.mask)+(m.adjM?1:0)), sol:0, layout:a}; buckets.set(k,b); }
  b.sol++;
}
const t1=Date.now();
console.log(`${H}x${W} block, ring=${ring} | sparse sweep (<=${MAX_RING_MINES} ring mines): ${swept} arrangements -> ${buckets.size} unique openings  [${t1-t0}ms]`);

function buildConcrete(layout){
  const board=[],state=[];
  for(let r=0;r<BR;r++){board.push(new Array(BC).fill(0));state.push(new Array(BC).fill(UNKNOWN));}
  const mine=(r,c)=> (r===cR&&c===cC) || (ringIdx[r+","+c]!==undefined && (layout&(1<<ringIdx[r+","+c])));
  for(let r=0;r<BR;r++)for(let c=0;c<BC;c++){
    if(mine(r,c)){ board[r][c]=MINE; continue; }
    let n=0; for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){ if(!dr&&!dc)continue; const nr=r+dr,nc=c+dc; if(nr>=0&&nr<BR&&nc>=0&&nc<BC&&mine(nr,nc)) n++; }
    board[r][c]=n;
  }
  for(const m of meta) state[m.r][m.c]=KNOWN;
  return {board,state};
}
function patternOf(b){
  let bi=0; const clueAt={}; for(const m of meta) clueAt[m.r+","+m.c]= m.boundary?b.bClues[bi++]:(m.adjM?1:0);
  return cells.map(([r,c])=> (r===cR&&c===cC)?"M":String(clueAt[r+","+c])).join(".");
}
function cascadeFor(board,state){ return (rr,cc)=>BL.cascadeReveal(rr,cc,BR,BC,(r,c)=>state[r][c]===UNKNOWN,(r,c)=>{state[r][c]=KNOWN;return false;},(r,c)=>board[r][c]); }

// 2. Cheap pre-pass ONLY to skip residue-0 openings (simple logic already solved them -> no case-split
//    possible -> can't be a gem). Everything else gets the full solver: residue size does NOT predict
//    solvability (a single case-split cascades through a 0 and can resolve a large residue at once).
// 3. Keep gems: full solve solved===true AND used a case-split.
let easy=0, fullRun=0, gems=[], enumOnlySolved=0, unsolved=0;
for(const b of buckets.values()){
  const c1=buildConcrete(b.layout);
  const capped=csp.analyzeBoard(c1.board,c1.state,{revealCell:cascadeFor(c1.board,c1.state), maxComplexity:7.9});
  const residue=capped.safeCovered;
  if(residue===0){ easy++; continue; } // solvable by trivial/subset alone -> not a case-analysis puzzle
  fullRun++;
  const c2=buildConcrete(b.layout);
  const full=csp.analyzeBoard(c2.board,c2.state,{revealCell:cascadeFor(c2.board,c2.state)});
  const hasCase=full.moves.some(m=>m.method==="case");
  const hasEnum=full.moves.some(m=>m.method==="enum");
  if(full.solved && hasCase){ gems.push({pattern:patternOf(b), sol:b.sol, max:+full.maxComplexity.toFixed(2), total:+full.totalComplexity.toFixed(2), enum:hasEnum, residue}); }
  else if(full.solved){ enumOnlySolved++; }
  else { unsolved++; }
}
const t2=Date.now();
console.log(`pre-pass: easy(residue 0, skipped)=${easy}, full-analyzed=${fullRun}`);
console.log(`full-analyzed -> solved+case GEMS=${gems.length}, solved-by-enum-only=${enumOnlySolved}, unsolved=${unsolved}   total time ${t2-t0}ms`);

// Gem report
gems.sort((a,b)=>b.max-a.max);
const bandHist={}; gems.forEach(g=>{const band=Math.floor(g.max);bandHist[band]=(bandHist[band]||0)+1;});
console.log(`\nGEMS (solved + requires case analysis): ${gems.length}`);
console.log("by max-complexity band:", bandHist);
const pureCase=gems.filter(g=>!g.enum).length;
console.log(`pure case-split (no brute enum): ${pureCase} / ${gems.length}`);
console.log("\ntop 12 by max complexity:");
for(const g of gems.slice(0,12)) console.log(`  max ${g.max}  total ${g.total}  sol ${g.sol}  residue ${g.residue}  ${g.enum?"(+enum)":"(case)"}  ${g.pattern}`);

// Example sanity check (only meaningful for the 4x4 family the example came from)
if(H!==4||W!==4){ return; }
const ex=gems.find(g=>g.pattern===EXAMPLE);
console.log(`\nexample ${EXAMPLE}: ` + (ex ? `FOUND as a gem (max ${ex.max}, sol ${ex.sol}, residue ${ex.residue})` : "NOT in gem set"));
if(!ex){
  // diagnose: is it even enumerated, and how was it classified?
  let found=null; for(const b of buckets.values()) if(patternOf(b)===EXAMPLE){found=b;break;}
  if(!found) console.log("  -> not enumerated (its lex-smallest layout has > MAX_RING_MINES mines; raise MAX_RING_MINES)");
  else {
    const c1=buildConcrete(found.layout); const cap=csp.analyzeBoard(c1.board,c1.state,{revealCell:cascadeFor(c1.board,c1.state),maxComplexity:7.9});
    const c2=buildConcrete(found.layout); const full=csp.analyzeBoard(c2.board,c2.state,{revealCell:cascadeFor(c2.board,c2.state)});
    console.log(`  -> enumerated; residue ${cap.safeCovered}, full solved=${full.solved} max=${full.maxComplexity.toFixed(2)} methods=${[...new Set(full.moves.map(m=>m.method))].join(",")}`);
  }
}
