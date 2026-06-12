#!/usr/bin/env node
// Template scout: describe a board layout with per-cell constraints, and find the HARDEST fully-solvable
// concrete board that satisfies them. Every earlier scout (corner-mine, two-mine) is just a template.
//
// TEMPLATE FORMAT — a grid of whitespace-separated tokens, one row per line (blank lines and `;` comments
// ignored). Each cell is one of:
//
//   0..8   revealed cell with that exact clue number   (player sees it; pins adjacent mines == N)
//   ?      revealed cell with ANY number               (player sees it; value falls out of the layout)
//   #      covered cell of ANY type                    (the search decides: mine or safe)   [the free vars]
//   *      covered MINE                                 (forced mine)
//   s      covered SAFE cell, any number                (guaranteed not a mine; covered at start)
//   A..I   covered SAFE cell with exact number 0..8     (A=0, B=1, … I=8; not a mine; pins adjacent mines)
//
// Aliases: `.`=`#`, `M`=`*`. The search enumerates which `#` cells are mines (sparse, up to MAX_MINES), adds
// the forced `*` mines, checks every fixed-number constraint, and requires a bounded opening (no revealed 0
// touching a covered cell). It then buckets candidates by the opening the player sees and — for free — uses
// the per-cell mine frequency to find each opening's forced-safe cells; an opening with NO forced-safe cell
// is unsolvable (the player can't make a first move) and is skipped without ever invoking the solver. The
// rest are solved WITH cascades, and the hardest fully-solvable board is reported.
//
//   node scripts/template-scout.js [template-file]   (no file => built-in 4x4 corner-mine demo)
//   MAX_MINES=8 ANALYSIS_CAP=14 node scripts/template-scout.js my-layout.txt
const fs = require("fs");
const BL = require("../src/common/BoardLogic");
const csp = require("../src/server/CSPSolver");
const MINE = BL.MINE, KNOWN = BL.KNOWN, UNKNOWN = BL.UNKNOWN;

const MAX_MINES = parseInt(process.env.MAX_MINES || "6", 10);
const TOP_N = parseInt(process.env.TOP_N || "5", 10);
// Cap analyzer complexity: skips giant brute-force enumerations (cost grows with component size, ~26 for an
// 18-cell frontier) — not human-solvable "good" puzzles anyway. Case-analysis gems sit well under this.
const ANALYSIS_CAP = parseFloat(process.env.ANALYSIS_CAP || "14");

const DEMO = `
; 4x4 corner-mine demo: revealed 4x4 interior (any numbers), one corner a covered mine,
; surrounded by a covered border the search fills with mines.
# # # # # #
# * ? ? ? #
# ? ? ? ? #
# ? ? ? ? #
# ? ? ? ? #
# # # # # #
`;

function parseCell(tok){
	if(/^[0-8]$/.test(tok)) return { kind:"clue", clue:+tok };
	if(tok==="?") return { kind:"revealedAny" };
	if(tok==="#"||tok===".") return { kind:"free" };
	if(tok==="*"||tok==="M") return { kind:"mine" };
	if(tok==="s") return { kind:"safeAny" };
	if(/^[A-I]$/.test(tok)) return { kind:"safeFixed", clue: tok.charCodeAt(0)-65 }; // A=0 .. I=8
	throw new Error("unknown template token: '"+tok+"'");
}

function parseTemplate(text){
	const lines = text.split("\n").map(l=>l.trim()).filter(l=>l.length && l[0]!==";");
	const grid = lines.map(l=>l.split(/\s+/).map(parseCell));
	const rows = grid.length, cols = grid[0].length;
	for(const r of grid) if(r.length!==cols) throw new Error("all template rows must have the same width");
	return { rows, cols, grid };
}

function analyzeTemplate(t){
	const forced=[], free=[], revealed=[], clueCon=[]; let hasSafe=false;
	for(let r=0;r<t.rows;r++)for(let c=0;c<t.cols;c++){
		const g=t.grid[r][c];
		if(g.kind==="mine") forced.push([r,c]);
		else if(g.kind==="free") free.push([r,c]);
		if(g.kind==="clue"||g.kind==="revealedAny") revealed.push([r,c]);
		if(g.kind==="clue"||g.kind==="safeFixed") clueCon.push([r,c,g.clue]);
		if(g.kind==="safeAny"||g.kind==="safeFixed") hasSafe=true;
	}
	return { forced, free, revealed, clueCon, hasSafe };
}

function combinations(n, k, cb){
	const idx=new Array(k);
	(function rec(start, depth){
		if(depth===k){ cb(idx); return; }
		for(let i=start;i<=n-(k-depth);i++){ idx[depth]=i; rec(i+1, depth+1); }
	})(0,0);
}

// Build the board for a mine set (Set of "r,c" keys).
function buildBoard(R, C, isMine){
	const board=[];
	for(let r=0;r<R;r++){board.push([]);for(let c=0;c<C;c++){
		if(isMine(r,c)){board[r].push(MINE);continue;}
		let n=0;for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){if(!dr&&!dc)continue;const nr=r+dr,nc=c+dc;if(nr>=0&&nr<R&&nc>=0&&nc<C&&isMine(nr,nc))n++;}
		board[r].push(n);
	}}
	return board;
}

function search(t){
	const { forced, free, revealed, clueCon, hasSafe } = analyzeTemplate(t);
	const R=t.rows, C=t.cols;
	const revealedKey={}; revealed.forEach(([r,c])=>revealedKey[r+","+c]=true);
	function mineSetOf(idxs){ const m=new Set(); for(const [r,c] of forced) m.add(r+","+c); for(const i of idxs){const [r,c]=free[i]; m.add(r+","+c);} return m; }

	// Pass 1: enumerate sparse layouts, validate, bucket by the opening the player sees. Per bucket track
	// each free cell's mine count across consistent layouts (the closure) so we can spot forced-safe cells.
	let tried=0, valid=0;
	const buckets=new Map();
	for(let k=0;k<=MAX_MINES;k++){
		combinations(free.length, k, (idxs)=>{
			tried++;
			const mset=mineSetOf(idxs);
			const board=buildBoard(R,C,(r,c)=>mset.has(r+","+c));
			for(const [r,c,N] of clueCon){ if(board[r][c]!==N) return; }              // fixed-number constraints
			for(const [r,c] of revealed){ if(board[r][c]!==0) continue;                 // bounded opening
				for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++){const nr=r+dr,nc=c+dc;if(nr<0||nr>=R||nc<0||nc>=C)continue;if(!revealedKey[nr+","+nc]) return;} }
			valid++;
			let key=""; for(const [r,c] of revealed) key+=board[r][c]+",";
			let b=buckets.get(key);
			if(!b){ b={orCount:new Int32Array(free.length), layouts:[]}; buckets.set(key,b); }
			b.layouts.push(idxs.slice());
			for(const i of idxs) b.orCount[i]++;
		});
	}

	// Pass 2: skip openings with no forced-safe cell (unsolvable — no possible first move), solve the rest.
	let solved=0, skippedUnsolvable=0, best=null; const tops=[];
	for(const b of buckets.values()){
		let forcedSafe = hasSafe; // any guaranteed-safe covered cell always gives a candidate first move
		if(!forcedSafe) for(let i=0;i<free.length;i++) if(b.orCount[i]===0){ forcedSafe=true; break; }
		if(!forcedSafe){ skippedUnsolvable += b.layouts.length; continue; }
		for(const idxs of b.layouts){
			const mset=mineSetOf(idxs);
			const board=buildBoard(R,C,(r,c)=>mset.has(r+","+c));
			const state=[]; for(let r=0;r<R;r++) state.push(new Array(C).fill(UNKNOWN));
			revealed.forEach(([r,c])=>state[r][c]=KNOWN);
			function casc(rr,cc){BL.cascadeReveal(rr,cc,R,C,(r,c)=>state[r][c]===UNKNOWN,(r,c)=>{state[r][c]=KNOWN;return false;},(r,c)=>board[r][c]);}
			const res=csp.analyzeBoard(board.map(r=>r.slice()),state,{revealCell:casc, maxComplexity:ANALYSIS_CAP});
			if(!res.solved) continue;
			solved++;
			const method=res.moves.reduce((acc,m)=> m.complexity>(acc.c||-1)?{m:m.method,c:m.complexity}:acc,{}).m;
			const rec={ max:res.maxComplexity, total:res.totalComplexity, method, board, mineKeys:[...mset] };
			tops.push(rec); if(!best||rec.max>best.max) best=rec;
		}
	}
	tops.sort((a,b)=>b.max-a.max||b.total-a.total);
	return { tried, valid, skippedUnsolvable, solved, best, tops:tops.slice(0,TOP_N), forced, free, revealed };
}

function renderBoard(res, info, t){
	const R=t.rows, C=t.cols, board=res.board;
	const mineSet={}; res.mineKeys.forEach(k=>mineSet[k]=true);
	const revealedKey={}; info.revealed.forEach(([r,c])=>revealedKey[r+","+c]=true);
	const pad=v=>(" "+v);
	let player="PLAYER VIEW (revealed numbers; · = covered):\n";
	for(let r=0;r<R;r++){let line=" ";for(let c=0;c<C;c++) line+= revealedKey[r+","+c]? pad(board[r][c]) : pad("·"); player+=line+"\n";}
	let truth="TRUE LAYOUT (* = mine):\n";
	for(let r=0;r<R;r++){let line=" ";for(let c=0;c<C;c++) line+= mineSet[r+","+c]? pad("*") : pad(board[r][c]); truth+=line+"\n";}
	return player+"\n"+truth;
}

function main(){
	const file=process.argv[2];
	const text = file ? fs.readFileSync(file,"utf8") : DEMO;
	const t = parseTemplate(text);
	console.log(`template ${t.rows}x${t.cols}, MAX_MINES=${MAX_MINES}, ANALYSIS_CAP=${ANALYSIS_CAP}`);
	const t0=Date.now();
	const out = search(t);
	const t1=Date.now();
	console.log(`free(#)=${out.free.length}, forced(*)=${out.forced.length}, revealed=${out.revealed.length}`);
	console.log(`layouts tried=${out.tried}, valid=${out.valid}, skipped-unsolvable(no forced-safe)=${out.skippedUnsolvable}, solved=${out.solved}  [${t1-t0}ms]`);
	if(!out.best){ console.log("\nno fully-solvable board satisfies this template (try raising MAX_MINES)."); return; }
	console.log(`\nHARDEST solvable: max complexity ${out.best.max.toFixed(2)} (hardest move: ${out.best.method}), total ${out.best.total.toFixed(2)}\n`);
	console.log(renderBoard(out.best, out, t));
	if(out.tops.length>1){
		console.log("top solvable boards by max complexity:");
		for(const r of out.tops) console.log(`  max ${r.max.toFixed(2)}  total ${r.total.toFixed(2)}  hardest-move ${r.method}  mines ${r.mineKeys.length}`);
	}
}
main();
