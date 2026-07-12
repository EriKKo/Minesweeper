// Learn page: interactive deduction trainer.
//
// Loaded via a <script> tag before the main inline script. Everything declared
// here (LEARN_COURSES, courseById, renderLearn, buildLearnPuzzle, ...) becomes
// a global the main script can reach. Depends on BoardLogic.* (cascadeReveal,
// chordContext, neighbours, buildClueGrid) and BoardRender.* (drawCell, DPR).

// ---- Learn: interactive deduction trainer ----
// Each puzzle is a small slice of a board. Tokens: 0-8 clue, "." covered (solve
// it), "*" known mine, "?" irrelevant/background (counts as no mine). The matching
// solution grid replaces each "." with M (mine), S (safe) or "." (undeterminable
// by this technique). Guess puzzles use G (lower-risk guess) / B (higher-risk).
var LEARN_COURSES = [
{
	id: "basics",
	title: "The Basics",
	sub: "How to play. Every move you can make.",
	lessons: [
	{
		title: "Revealing cells",
		steps: [
		{
			// One mine dead centre on a 5x5 board: a corner cascade (pre-applied here via revealStart,
			// so the player isn't asked to find/click it themselves) opens the ENTIRE rest of the board
			// in one go (verified — leaves only the mine covered), so this one board demonstrates both
			// a cascade AND a mine without the player needing to do anything but look, then click the
			// one cell left. Deliberately backwards on the mine itself: before explaining "avoid
			// mines," let the player click it on purpose, risk-free, so "mine" is a concrete thing
			// they've seen rather than an abstract warning. Reused (see the "Flagging cells" lesson
			// below) with the objective swapped to mustFlag instead of clickMine — same board, same
			// cascade, the new skill applied to it.
			board: { rows: 5, cols: 5, mines: [[2,2]], revealStart: [0,0], clickMine: true },
			intro: [
				"Left-click the cell to see what's inside."
			],
			outro: "That's a mine. Hit one in a real game and it's over. Now let's reveal a cell for real."
		},
		{
			// Moved here from "Simple deductions" — it's the same core skill (left-click to reveal)
			// as this lesson's first puzzle, just requiring one read of the numbers instead of a
			// free pass. Mine sits one cell in from a corner — a real cascade from elsewhere opens
			// everything except the mine and the one cell diagonally past it, which never gets an
			// automatic 0-neighbour of its own. Cleared normally: reveal the safe cell, mine stays covered.
			board: { rows: 7, cols: 9, mines: [[1,2]], revealStart: [6,8] },
			intro: [
				"A number counts the mines touching it. One cell here is safe — find it."
			],
			hints: [
				"The '1' below-left of the mine touches only one covered cell — that's the mine.",
				"The '1' above-right of it is already satisfied by that same mine.",
				"So its other covered neighbour is safe. Click it."
			],
			mistakes: {
				mine: "That was the mine. Check the '1's again."
			},
			outro: "That's reading the board — no guessing."
		}
		]
	},
	{
		title: "Flagging cells",
		steps: [
		{
			// Same 5x5 board as "Revealing cells" — the cascade is already applied (revealStart)
			// since that lesson already covered clicking a corner to open it; here the only thing
			// left to do is flag the one covered cell instead of clicking it.
			board: { rows: 5, cols: 5, mines: [[2,2]], revealStart: [0,0], mustFlag: true },
			intro: [
				"Right-click a cell to flag it. Right-click again to unflag."
			],
			outro: "Flagged. One mine's easy — let's try a few more."
		},
		{
			// Two separate groups (a 2-mine pair, a 3-mine L-tromino), spaced far enough apart that
			// each mine still gets its own exclusive '1' — no chaining needed, just more of them to
			// find. Real cascade from a corner opens everything except the five mines themselves.
			board: {
				rows: 6, cols: 11,
				mines: [[2,2], [2,3], [2,7], [2,8], [3,7]],
				revealStart: [5,0],
				mustFlag: true
			},
			intro: [ "Five mines this time — two groups. Flag every one." ],
			hints: [
				"The pair on the left each have their own '1' — find both.",
				"The three on the right work the same way, one '1' per mine.",
				"Flag all five once every mine is pinned."
			],
			mistakes: {
				wrongFlag: "Not a mine — check the numbers around it."
			},
			outro: "In a real game, flagging is optional — nothing forces you to place one. But it's a great tool for keeping track of what you've already worked out."
		}
		]
	},
	{
		title: "Simple deductions",
		steps: [
		{
			// A single mine a full step diagonally off the corner instead of straight off an edge —
			// its 8-neighbourhood now traps THREE cells with no 0-neighbour of their own, not one:
			// the two cells flanking it, and the true corner beyond them, freed only once one
			// flanking cell is revealed and its own (now-satisfied) number frees the next.
			board: { rows: 6, cols: 9, mines: [[1,1]], revealStart: [5,8] },
			intro: [ "This mine sits one step off the corner instead of the edge — three safe cells to find, not one." ],
			hints: [
				"The '1' past the mine, away from the corner, touches only one covered cell — that's the mine.",
				"That satisfies the numbers next to it — the two cells flanking the mine are safe.",
				"Reveal those, and their own numbers free the last cell, right in the corner."
			],
			mistakes: {
				mine: "That was the mine. Check the '1's again."
			},
			outro: "Read a number, chase it to the next one — that's all deduction ever is."
		},
		{
			// Two mines side by side, flush against the top wall and one cell in from the corner —
			// the classic 1-2-2-1 wall run. The far '2' touches only the two mines and forces both at
			// once; the near '1' is then already satisfied, freeing the corner cell.
			board: { rows: 6, cols: 9, mines: [[0,1], [0,2]], revealStart: [5,8] },
			intro: [ "Two mines side by side against the wall. Which cell is safe?" ],
			hints: [
				"The second '2' (away from the corner) touches only the two mines and nothing else — both are forced.",
				"Once both mines are known, the '1' nearest the corner is already satisfied.",
				"That leaves the corner cell safe. Click it."
			],
			mistakes: {
				mine: "That was a mine. Check the numbers along the wall again."
			},
			outro: "The classic 1-2-2-1 wall pattern — two mines confirmed from one number, the corner falls out."
		},
		{
			// Adapted from the real puzzle pool (id 100), shifted one cell so the true corner (3,3)
			// is safe rather than a mine. The '2' pins both mines in one read; the corner itself only
			// has covered/mine neighbours to start, so it isn't freed until the cell beside it is
			// revealed and contributes its own (now-satisfied) number — a real two-hop chain.
			board: {
				rows: 4, cols: 4,
				mines: [[2,2], [3,2]],
				revealed: [[0,0],[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[3,0],[3,1]]
			},
			intro: [ "Same two-mine idea, but tucked into a corner this time. Find both safe cells." ],
			hints: [
				"A '2' touches both covered cells next to it — exactly its count, so both are mines.",
				"The 1s beside them are already satisfied by those two mines — the third covered cell is safe.",
				"Click it — revealing it uncovers its own number, which frees the last cell in the corner."
			],
			mistakes: {
				mine: "That was a mine. Check the 1s around it again."
			},
			outro: "Same trick, two mines and two safe cells this time."
		},
		{
			// Real puzzle pool, id 52 — plus one extra mine added at the bottom-left corner (4,0),
			// paired with the pool's original lone mine at (3,1); and the board widened by one
			// column with the bottom-right mine shifted from (4,6) to (4,7), opening a one-cell gap
			// at (4,6) that no cascade can reach (all three of its neighbours border a mine). Reading
			// the row above that gap: 1-1-2-1 — each mine pinned by its own exclusive '1', then the
			// '2' between them (now satisfied by both) frees the gap cell itself.
			board: {
				rows: 5, cols: 8,
				mines: [[0,4], [3,1], [4,0], [4,5], [4,7]],
				revealed: [[0,0],[0,1],[0,2],[0,3],[0,5],[0,6],[0,7],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],
					[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[2,6],[2,7],[3,2],[3,3],[3,4],[3,5],[3,6],[3,7],[4,2],[4,3],[4,4]]
			},
			intro: [ "Five mines scattered around the board. Find the safe cells." ],
			hints: [
				"Treat each cluster on its own — the lone mine at the top pins the same way as always.",
				"The corner pair in the bottom-left, and each mine in the bottom-right pair, still get their own exclusive '1'.",
				"Once both bottom-right mines are pinned, the '2' between them is satisfied — the gap cell is safe."
			],
			mistakes: {
				mine: "That was a mine. Check the numbers around it again."
			},
			outro: "That's the toolkit: read a number, work out what's forced. One more board to go."
		},
		{
			// Real puzzle pool, id 41 — three mines run along the left edge, an L rather than a chain,
			// with three safe cells clustered in the corner they leave behind.
			board: {
				rows: 4, cols: 4,
				mines: [[0,0], [1,0], [2,1]],
				revealed: [[0,1],[0,2],[0,3],[1,1],[1,2],[1,3],[2,2],[2,3],[3,2],[3,3]]
			},
			intro: [ "Three mines along the edge this time. Find all three safe cells." ],
			hints: [
				"The '2' at the top touches two covered cells — exactly its count, so both are mines.",
				"The '1' next to it has only one covered cell left uncovered by those two — that's the third mine.",
				"With all three pinned, the numbers below them are already satisfied — those cells are safe."
			],
			mistakes: {
				mine: "That was a mine. Check the numbers around it again."
			},
			outro: "Same idea, just more numbers to read before it clicks."
		}
		]
	},
	{
		title: "Chord clicks",
		steps: [
		{
			board: {
				rows: 3,
				cols: 9,
				mines: [[0,1], [0,4], [0,7], [1,3], [1,6], [1,8]],
				flagged: [[0,1], [0,4], [0,7], [1,3], [1,6], [1,8]],
				revealed: [[1,1], [1,4], [1,7]],
				chordOnly: true
			},
			intro: [
				"Click a satisfied number to chord — it opens all its other neighbours at once."
			],
			hints: [
				"Click the number itself, not a covered cell.",
				"Left- or right-click both work.",
				"Chord each of the three numbers in the middle row."
			],
			outro: "Chording: the fastest way to open cells you've already worked out."
		}
		]
	}
	]
},
{
	id: "simple",
	title: "Simple moves",
	sub: "Two rules, and how far they take you.",
	lessons: [
	{
		title: "The two rules",
		steps: [
		{
			// A pure reference step, no puzzle to solve — see the rulesPanel branch in loadStep.
			// Lesson has just this one step: watch the two rules happen, then go practice them for
			// real on the first puzzle of the next lesson.
			intro: [
				"Just two rules solve almost every board. Watch them below, then try them yourself."
			],
			rulesPanel: {
				rules: [
					{
						label: "Rule #1",
						desc: "Find a cell that only has mines left around it, and flag them all.",
						demos: [
							{
								// Two covered cells tucked in the top-right corner — one size up from
								// the smallest possible case, sitting at the top of a much larger
								// cascaded board (same size as Rule #2's demos) so it reads as one
								// corner of a real board rather than a bare scrap.
								rows: 4, cols: 6,
								mines: [[0,4], [0,5]],
								revealed: [[0,0],[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],
									[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,0],[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [1,4],
								targets: [[0,4], [0,5]],
								action: "flag"
							},
							{
								// A '3' with exactly three covered cells beneath it, grown to an
								// L of four mines — three across the top plus one more hanging down
								// from the right end — with a single clue cell still touching all
								// four (a straight run of four is one mine too wide for any one
								// clue to reach every cell, so the extra mine has to turn a corner).
								rows: 4, cols: 6,
								mines: [[0,1], [0,2], [0,3], [1,3]],
								revealed: [[0,0],[0,4],[0,5],[1,0],[1,1],[1,2],[1,4],[1,5],
									[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,0],[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [1,2],
								targets: [[0,1], [0,2], [0,3], [1,3]],
								action: "flag"
							},
							{
								// A '2' on the left edge, grown to three mines — same idea, one size
								// up, and this time bordering the side of the board instead of the
								// top. The clue cell sits one column in rather than flush against the
								// edge, since it needs to reach all three mines, not just two. Not
								// every covered cell on this board is a mine, though: a fourth mine
								// sits unflagged at (2,4), invisible until some other clue explains
								// it, and (3,4) right next to it is genuinely safe — neither one is
								// reachable from the highlighted clue, so this demo doesn't touch them.
								rows: 4, cols: 6,
								mines: [[0,0], [0,1], [0,2], [2,4]],
								revealed: [[0,3],[0,4],[0,5],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],
									[2,0],[2,1],[2,2],[2,3],[2,5],[3,0],[3,1],[3,2],[3,3],[3,5]],
								clueCell: [1,1],
								targets: [[0,0], [0,1], [0,2]],
								action: "flag"
							},
							{
								// Four mines running down the right edge, but the highlighted clue is
								// the '1' below all of them — it only touches the bottom mine, so only
								// that one gets flagged here. The other three stay covered the whole
								// time: a reminder that a clue only tells you about its own immediate
								// neighbours, not about a whole cluster sitting nearby. Two of those
								// three really are mines (one more sits unflagged at (1,3), shielding
								// the board's left side from a cascade); the third, (1,5), is genuinely
								// safe — from the outside the three look identical.
								rows: 4, cols: 6,
								mines: [[0,4], [0,5], [1,3], [2,5]],
								revealed: [[0,0],[0,1],[0,2],[0,3],[1,0],[1,1],[1,2],[1,4],
									[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [3,5],
								targets: [[2,5]],
								action: "flag"
							}
						]
					},
					{
						label: "Rule #2",
						desc: "Find a cell that already has all its mines flagged, and reveal all its other cells.",
						demos: [
							{
								// Three covered cells in a row, mine on the right: the '1' beyond it
								// touches only that one covered cell, so it's flagged by simple count-
								// matching (rule #1) — no elimination needed. That satisfies the '1'
								// below the row, freeing (0,0) — which is itself a '0', so revealing
								// it really is a cascade (revealFrom, not a hand-picked targets list):
								// it opens (0,1) and (1,0) too, and (1,0) being also '0' carries it one
								// step further into (2,0), which is where the actual cascade algorithm
								// stops, since that cell is nonzero. The entire left column stays
								// covered until then. A second, unflagged mine tucked in the
								// bottom-left corner is what lets the rest of the board cascade open
								// around it without that same cascade reaching in and prematurely
								// revealing the covered cells above it.
								rows: 4, cols: 6,
								mines: [[0,2], [3,0]],
								flagged: [[0,2]],
								revealed: [[0,3],[0,4],[0,5],[1,1],[1,2],[1,3],[1,4],[1,5],
									[2,1],[2,2],[2,3],[2,4],[2,5],
									[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [1,1],
								revealFrom: [0,0],
								action: "reveal"
							},
							{
								// Top row: four covered cells (two mines, a target, then a third
								// mine), then a revealed '1' and an empty cell. The '2' below the
								// pair forces them, the '1' below the lone mine forces it too — once
								// all three are flagged, the '2' between them is satisfied and frees
								// the target sitting right in the middle of the row.
								rows: 4, cols: 6,
								mines: [[0,0], [0,1], [0,3]],
								flagged: [[0,0], [0,1], [0,3]],
								revealed: [[0,4],[0,5],
									[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],
									[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],
									[3,0],[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [1,2],
								targets: [[0,2]],
								action: "reveal"
							},
							{
								// Same idea, two mines this time and two cells freed at once. Each
								// mine is independently provable too — a different '1' elsewhere
								// touches only one of them apiece — so nothing here is just asserted.
								rows: 4, cols: 6,
								mines: [[0,2], [1,0]],
								flagged: [[0,2], [1,0]],
								revealed: [[0,3],[0,4],[0,5],[1,1],[1,2],[1,3],[1,4],[1,5],
									[2,0],[2,1],[2,2],[2,3],[2,4],[2,5],[3,0],[3,1],[3,2],[3,3],[3,4],[3,5]],
								clueCell: [1,1],
								targets: [[0,0], [0,1]],
								action: "reveal"
							}
						]
					}
				]
			}
		}
		]
	},
	{
		title: "Row by row",
		steps: [
		{
			// A real cascade (revealStart) opens two clean rows above the border, like a real
			// opening would, before the mines start — instead of the clue row sitting right at the
			// board's top edge. Mines split across BOTH covered rows (not just the first), since a
			// real board never leaves a whole row guaranteed mine-free.
			board: { rows: 5, cols: 5, mines: [[3,3], [3,4], [4,0]], revealStart: [0,0] },
			intro: [
				"Start from a corner when you can — fewer neighbours means its number is easiest to trust completely."
			],
			hints: [
				"Work along the border row first — each number either matches its covered neighbours (flag) or is already satisfied (reveal).",
				"Once the first covered row is sorted, its own numbers are enough to explain the row behind it too."
			],
			mistakes: {
				mine: "That was a mine. Go back to a number that's fully explained by its flagged neighbours, and work outward from there."
			},
			outro: "Same two rules, twice: once to clear the first row, once more for the row behind it — mines and all, in both."
		},
		{
			// Wider, more mines, still split across both covered rows.
			board: {
				rows: 5, cols: 6,
				mines: [[3,1], [3,3], [4,2], [4,3]],
				revealStart: [0,0]
			},
			intro: [ "Wider now — and this time the second row isn't a free pass either." ],
			hints: [
				"Start at a number that already matches its covered neighbours exactly.",
				"Work across one number at a time. Nothing here needs more than the two rules."
			],
			mistakes: {
				mine: "That was a mine. Find a number that's fully explained already, and work outward from it."
			},
			outro: "Same idea, just more of it — the two rules don't care how wide the board is, or which row the mines are in."
		},
		{
			// Wider still, mines in both rows again, one board hugging the right edge.
			board: {
				rows: 5, cols: 7,
				mines: [[3,6], [4,0], [4,1], [4,3], [4,6]],
				revealStart: [0,0]
			},
			intro: [ "Wider again. Same two rules, just more of the board to work through." ],
			hints: [
				"Same start as always: a number that matches its covered neighbours exactly.",
				"Work across one number at a time — flag what matches, reveal what's satisfied."
			],
			mistakes: {
				mine: "That was a mine. Find what's already explained, and work outward from it."
			},
			outro: "That's row by row: work the first covered row with the two rules, and the row behind it falls out the same way."
		},
		{
			// Widest and busiest of the set — six mines split across both rows, 11 forced moves.
			board: {
				rows: 5, cols: 8,
				mines: [[3,0], [3,2], [3,3], [3,4], [4,0], [4,5]],
				revealStart: [0,0]
			},
			intro: [
				"The widest one yet. Same two rules — just more of them to chain together.",
				"If you get stuck in one section of the board, move over and look for opportunities somewhere else."
			],
			hints: [
				"Start from a number that already matches its covered neighbours exactly.",
				"Work across the row one number at a time. Every mine here — top row or bottom — comes from the same two rules."
			],
			mistakes: {
				mine: "That was a mine. Eight columns or five, the method's the same — find what's already explained and work outward."
			},
			outro: "That's the whole lesson: reveal what you can, and the rest reveals itself, row after row."
		}
		]
	},
	{
		title: "Clearing a whole board",
		steps: [
		{
			// Real puzzle pool, id 67 — a genuine two-dimensional board (not just rows stacked on
			// rows), so the same two rules now have to be found in any direction, not just left to
			// right. Kept from the original version of this course.
			board: {
				rows: 6, cols: 5,
				mines: [[0,3], [3,4], [4,1], [5,4]],
				revealed: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[1,3],[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3]]
			},
			intro: [ "One more board — a real one, not just rows stacked on rows. Same two rules, any direction." ],
			hints: [
				"If a number's covered cells don't resolve yet, leave it — try a different number first.",
				"There's no required order. Work whichever number is easiest right now."
			],
			mistakes: {
				mine: "That was a mine. Check a number you haven't tried yet."
			},
			outro: "That's a real two-dimensional board cleared — the rest of this lesson just makes them bigger."
		},
		{
			// Real puzzle pool, id 163 — one mine more than the last board, still fully clearable
			// with only the two rules (verified by simulating trivial-only flag/reveal to
			// completion before wiring it in).
			board: {
				rows: 6, cols: 5,
				mines: [[2,0], [2,4], [3,1], [4,0], [5,4]],
				revealed: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[2,1],[2,2],[2,3]]
			},
			intro: [ "Bigger now — five mines instead of four, spread across more of the board." ],
			hints: [
				"Same approach: find a number whose covered cells already match its count, or one whose mines are already flagged.",
				"Work outward from whichever number is easiest, in any direction."
			],
			mistakes: {
				mine: "That was a mine. Look for a number that's already fully explained, and work outward from it."
			},
			outro: "Same two rules, just more of the board — size doesn't change the method."
		},
		{
			// Real puzzle pool, id 195 — wider still, six mines spread across the full width of
			// the board. Also verified fully trivial-solvable before wiring it in.
			board: {
				rows: 6, cols: 8,
				mines: [[2,3], [2,7], [3,3], [3,7], [4,5], [5,7]],
				revealed: [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[0,7],[1,0],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],[1,7],
					[2,0],[2,1],[2,2],[2,4],[2,5],[2,6],[3,0],[3,1],[3,2],[3,4],[3,5],[3,6],
					[4,0],[4,1],[4,2],[4,3],[4,4],[5,0],[5,1],[5,2],[5,3],[5,4]]
			},
			intro: [ "Wider still, and the mines are spread across the whole width of the board." ],
			hints: [
				"Nothing new here — just more numbers to work through with the same two rules.",
				"If one area stalls, move to another part of the board and come back to it after."
			],
			mistakes: {
				mine: "That was a mine. Move to a number you haven't worked yet, and come back to this area after."
			},
			outro: "Same two rules cover a board this size just as easily as a small one."
		},
		{
			// Real puzzle pool, id 88 — the biggest and busiest board in the course, 7x7 with six
			// mines. Still fully trivial-solvable (verified the same way as the other three), so
			// even at this size, nothing here needs more than the two rules.
			board: {
				rows: 7, cols: 7,
				mines: [[0,0], [2,1], [2,5], [4,1], [5,6], [6,4]],
				revealed: [[0,1],[0,2],[0,3],[0,4],[0,5],[0,6],[1,1],[1,2],[1,3],[1,4],[1,5],[1,6],
					[2,2],[2,3],[2,4],[3,2],[3,3],[3,4],[3,5],[4,2],[4,3],[4,4],[4,5],[5,2],[5,3],[5,4],[5,5]]
			},
			intro: [ "The biggest board yet — six mines, no shortcuts, still just the two rules." ],
			hints: [
				"Work through it the same way as every board before this one: match the count to flag, satisfy the count to reveal.",
				"There's no trick here — just more of the board to cover."
			],
			mistakes: {
				mine: "That was a mine. Every mine on this board is findable with the two rules — check what's already explained."
			},
			outro: "That's the whole course: two simple rules, patiently applied, clear a board of any size."
		}
		]
	}
	]
},
{
	id: "intermediate",
	title: "Intermediate moves",
	sub: "When one number isn't enough, compare two.",
	lessons: [
	{
		title: "Nested numbers — safe cells",
		steps: [
		{
			// Real puzzle pool, id 134 — the cleanest possible nested pair: two mines at the ends
			// of a row of four covered cells, under four "1"s. The rightmost 1 reaches two covered
			// cells; the one beside it reaches those same two, plus one more. Same mine count (1
			// each), so the extra cell the bigger one alone reaches has to be safe.
			board: {
				rows: 5, cols: 4,
				mines: [[1,0], [1,3]],
				revealed: [[2,0],[2,1],[2,2],[2,3],[3,0],[3,1],[3,2],[3,3],[4,0],[4,1],[4,2],[4,3]]
			},
			intro: [
				"New trick: comparing two numbers side by side, not just reading one alone.",
				"Look at the two rightmost 1s in that row of four covered cells."
			],
			hints: [
				"The rightmost '1' only touches two covered cells. The one beside it touches those same two, plus one more.",
				"Both need exactly one mine. The smaller one already accounts for it — so the extra cell the bigger one alone reaches must be safe.",
				"That's the second cell from the left in the covered row. Click it."
			],
			mistakes: {
				mine: "That was a mine. Compare the two 1s again — one of them reaches one extra cell the other doesn't."
			},
			outro: "That's a nested pair: one number's reach sits entirely inside another's. Same mine count, so the extra reach is safe."
		}
		]
	},
	{
		title: "Nested numbers — forced mines",
		steps: [
		{
			// Real puzzle pool, id 81 — same nested idea, flipped: the bigger number here needs
			// MORE mines than the smaller one, by exactly its one extra cell.
			board: {
				rows: 4, cols: 4,
				mines: [[1,3], [2,3]],
				revealed: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2],[3,0],[3,1],[3,2]]
			},
			intro: [ "Same trick, flipped: this time the bigger number needs MORE mines than the smaller one." ],
			hints: [
				"The '1' near the bottom of that column touches two covered cells. The '2' just above it touches those same two, plus one more.",
				"The '2' needs one more mine than the '1' — and it only has one extra cell to put it in.",
				"That extra cell has to be a mine."
			],
			mistakes: {
				mine: "That was a mine. Compare the numbers again — the '2' already told you which extra cell had to be the mine."
			},
			outro: "Same trick, opposite outcome: when the bigger number needs more mines than the smaller one, its extra cells are forced mines."
		}
		]
	},
	{
		title: "Comparing numbers twice",
		steps: [
		{
			// Real puzzle pool, id 193 — one nested-pair comparison forces a mine; that changes what
			// a DIFFERENT pair of numbers can tell you, and a second comparison is needed before the
			// rest falls out trivially. The point: one comparison often isn't the end of it.
			board: {
				rows: 4, cols: 4,
				mines: [[1,3], [2,0], [2,2]],
				revealed: [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2]]
			},
			intro: [ "Sometimes one comparison isn't enough — a second pair of numbers needs comparing too." ],
			hints: [
				"Start with the '1' and the '2' that share two covered cells — the '2' needs one more mine, and it only has one extra cell.",
				"Once that mine is placed, re-read the numbers around it — a different pair is now ready to compare.",
				"Keep comparing pairs as you go. Solving one often sets up the next."
			],
			mistakes: {
				mine: "That was a mine. Go back to comparing numbers in pairs — there's always another pair ready to compare."
			},
			outro: "That's the real skill: not just spotting one nested pair, but re-comparing as new numbers turn up."
		}
		]
	},
	{
		title: "Clearing harder boards",
		steps: [
		{
			// Real puzzle pool, id 150 — a full small-board clear mixing trivial reads with nested
			// comparisons, instead of one isolated pattern. Same idea as Simple moves' capstone, one
			// tier harder.
			board: {
				rows: 4, cols: 4,
				mines: [[0,1], [1,0], [2,3]],
				revealed: [[2,0],[2,1],[2,2],[3,0],[3,1],[3,2]]
			},
			intro: [ "Now put it together — clear a whole board, comparing numbers wherever one read isn't enough." ],
			hints: [
				"Start with the plain reads first — they'll open up more of the board.",
				"When a number alone doesn't resolve, look for a second number whose reach overlaps or nests inside it."
			],
			mistakes: {
				mine: "That was a mine. Somewhere else on the board a number — or a nested pair — is ready to read."
			},
			outro: "Trivial reads and nested comparisons, chained together. That's the toolkit so far."
		},
		{
			// Real puzzle pool, id 65 — bigger board, three separate nested comparisons instead of
			// one, each in its own area.
			board: {
				rows: 5, cols: 6,
				mines: [[0,0], [0,4], [3,1], [3,3], [4,4]],
				revealed: [[0,1],[0,2],[0,3],[1,1],[1,2],[1,3],[2,1],[2,2],[2,3]]
			},
			intro: [ "Bigger board, same idea. Three separate nested comparisons this time." ],
			hints: [
				"Work each side of the board on its own — the comparisons don't depend on each other.",
				"If a number's covered cells don't resolve alone, find the number next to it that shares them."
			],
			mistakes: {
				mine: "That was a mine. Try a different number — the board has more than one place to compare from."
			},
			outro: "Same reading, more of it — and more places where two numbers had to work together."
		},
		{
			// Real puzzle pool, id 155 — wider board still; most of it opens with plain trivial reads
			// before the nested comparisons show up deeper in.
			board: {
				rows: 6, cols: 6,
				mines: [[1,0], [1,2], [1,5], [2,2], [3,4], [4,2]],
				revealed: [[2,0],[2,1],[3,0],[3,1],[4,0],[4,1],[5,0],[5,1]]
			},
			intro: [ "A wider board now. Most of it opens up before you even need to compare two numbers." ],
			hints: [
				"Clear the trivial reads first, working down the left side.",
				"The nested comparisons show up once you're deeper into the board — keep an eye out for them."
			],
			mistakes: {
				mine: "That was a mine. Check the numbers you haven't read yet before comparing pairs."
			},
			outro: "Bigger, but the same two tools: read a number, or compare two of them."
		},
		{
			// Real puzzle pool, id 84 — the biggest board in the course, and the most nested
			// comparisons needed in a row (four).
			board: {
				rows: 6, cols: 7,
				mines: [[0,3], [1,1], [1,6], [2,3], [4,2], [4,3]],
				revealed: [[2,4],[2,5],[2,6],[3,4],[3,5],[3,6],[4,4],[4,5],[4,6],[5,4],[5,5],[5,6]]
			},
			intro: [ "The biggest board in this course — and the most nested comparisons you'll need in a row." ],
			hints: [
				"Work in from both sides — one cluster of numbers is forming on the right, another on the left.",
				"Whenever you get stuck, look for two numbers sharing covered cells — one of them almost always resolves the other."
			],
			mistakes: {
				mine: "That was a mine. Somewhere else on the board, a number or a nested pair is still ready to go."
			},
			outro: "That's Intermediate moves: read what's forced, compare what isn't, and the board opens up."
		}
		]
	}
	]
},
{
	id: "speed",
	title: "Speed solving",
	sub: "Finish boards faster with fewer clicks.",
	lessons: [
	{
		title: "Smart guessing",
		idea: "When forced to guess, pick the group with the lowest per-cell mine probability.",
		how: "Risk per cell ≈ mines ÷ candidates. A 1 over 3 cells (33%) beats a 1 over 2 cells (50%).",
		guess: true,
		puzzles: [
			{
				title: "Two cells vs three",
				rows: 3,
				cols: 5,
				mines: [[0,0], [0,1]],
				revealAll: true,
				covered: [[0,2], [0,3], [0,4]],
				goodGuessCells: [[0,2], [0,3], [0,4]],
				guess: true,
				why: "Left 1 over two cells → 1/2 each. Right 1 over three cells → 1/3 each. Guess in the right group."
			},
			{
				title: "Watch the number",
				rows: 3,
				cols: 5,
				mines: [[0,2], [0,3], [0,4]],
				revealAll: true,
				covered: [[0,0], [0,1]],
				goodGuessCells: [[0,0], [0,1]],
				guess: true,
				why: "Left 1 over two cells → 1/2 each. Right 2 over three cells → 2/3 each. This time the left group is safer."
			}
		]
	}
	]
}
];

function courseById(id) {
	for (var i = 0; i < LEARN_COURSES.length; i++) if (LEARN_COURSES[i].id === id) return LEARN_COURSES[i];
	return null;
}

// ---- Learn course state ------------------------------------------------
var LEARN_STATE_KEY = "msbattle.learn.progress.v3";

function emptyCompletedMap() {
	var m = {};
	for (var i = 0; i < LEARN_COURSES.length; i++) {
		m[LEARN_COURSES[i].id] = new Array(LEARN_COURSES[i].lessons.length).fill(false);
	}
	return m;
}

function emptyCompletedAtMap() {
	var m = {};
	for (var i = 0; i < LEARN_COURSES.length; i++) m[LEARN_COURSES[i].id] = null;
	return m;
}

// `currentCourseId` null = course-list home. Otherwise the user is inside a
// specific course at `currentLesson`. When `currentLesson === lessons.length`
// for the active course, the course-complete card takes over.
var learnState = {
	currentCourseId: null,
	currentLesson: 0,
	completed: emptyCompletedMap(),
	completedAt: emptyCompletedAtMap()
};

function loadLearnState() {
	try {
		var raw = localStorage.getItem(LEARN_STATE_KEY);
		if (!raw) return;
		var parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return;
		var completed = emptyCompletedMap();
		var completedAt = emptyCompletedAtMap();
		if (parsed.completed && typeof parsed.completed === "object") {
			for (var i = 0; i < LEARN_COURSES.length; i++) {
				var c = LEARN_COURSES[i];
				var saved = parsed.completed[c.id];
				if (Array.isArray(saved)) {
					for (var j = 0; j < c.lessons.length && j < saved.length; j++) {
						completed[c.id][j] = !!saved[j];
					}
				}
				if (parsed.completedAt && typeof parsed.completedAt === "object" && parsed.completedAt[c.id]) {
					completedAt[c.id] = parsed.completedAt[c.id];
				}
			}
		}
		learnState.completed = completed;
		learnState.completedAt = completedAt;
		learnState.currentCourseId = (typeof parsed.currentCourseId === "string" && courseById(parsed.currentCourseId)) ? parsed.currentCourseId : null;
		learnState.currentLesson = Math.max(0, parsed.currentLesson | 0);
	} catch (e) { /* ignore corrupt state */ }
}

function saveLearnState() {
	try { localStorage.setItem(LEARN_STATE_KEY, JSON.stringify(learnState)); } catch (e) {}
}

function courseIsComplete(courseId) {
	var arr = learnState.completed[courseId];
	if (!arr) return false;
	for (var i = 0; i < arr.length; i++) if (!arr[i]) return false;
	return arr.length > 0;
}

function courseProgress(courseId) {
	var arr = learnState.completed[courseId] || [];
	var done = 0;
	for (var i = 0; i < arr.length; i++) if (arr[i]) done++;
	return { done: done, total: arr.length };
}

function firstIncompleteLesson(courseId) {
	var arr = learnState.completed[courseId] || [];
	for (var i = 0; i < arr.length; i++) if (!arr[i]) return i;
	return 0; // course already complete — start from the beginning for review
}

function enterCourse(courseId) {
	learnState.currentCourseId = courseId;
	learnState.currentLesson = firstIncompleteLesson(courseId);
	saveLearnState();
	renderLearn();
}

function exitToCourseList() {
	learnState.currentCourseId = null;
	saveLearnState();
	renderLearn();
}

function renderLearn() {
	var home = document.getElementById("learn_home");
	var course = document.getElementById("learn_course");
	if (!home || !course) return;
	if (learnState.currentCourseId && courseById(learnState.currentCourseId)) {
		home.style.display = "none";
		course.style.display = "";
		renderLearnCourse(courseById(learnState.currentCourseId));
	} else {
		home.style.display = "";
		course.style.display = "none";
		renderLearnHome();
	}
}

function renderLearnHome() {
	var list = document.getElementById("learn_courses_list");
	if (!list) return;
	list.innerHTML = "";
	for (var i = 0; i < LEARN_COURSES.length; i++) {
		(function(idx) {
			var c = LEARN_COURSES[idx];
			var prog = courseProgress(c.id);
			var done = courseIsComplete(c.id);
			var locked = false; // courses are open — pick them in any order
			var card = document.createElement("button");
			card.type = "button";
			card.className = "learn-course-card" + (done ? " done" : "") + (locked ? " locked" : "");
			card.disabled = locked;

			var top = document.createElement("div");
			top.className = "learn-course-top";
			var num = document.createElement("span");
			num.className = "learn-course-num";
			num.textContent = "Course " + (idx + 1);
			top.appendChild(num);
			if (done) {
				var badge = document.createElement("span");
				badge.className = "learn-course-badge";
				badge.textContent = "✓ Done";
				top.appendChild(badge);
			} else if (locked) {
				var lock = document.createElement("span");
				lock.className = "learn-course-badge locked";
				lock.textContent = "Locked";
				top.appendChild(lock);
			}
			card.appendChild(top);

			var title = document.createElement("h2");
			title.className = "learn-course-card-title";
			title.textContent = c.title;
			card.appendChild(title);

			var sub = document.createElement("p");
			sub.className = "learn-course-card-sub";
			sub.textContent = c.sub;
			card.appendChild(sub);

			var bar = document.createElement("div");
			bar.className = "learn-course-bar";
			var fill = document.createElement("div");
			fill.className = "learn-course-bar-fill";
			fill.style.width = (prog.total ? Math.round(100 * prog.done / prog.total) : 0) + "%";
			bar.appendChild(fill);
			card.appendChild(bar);

			var meta = document.createElement("div");
			meta.className = "learn-course-meta";
			var counts = document.createElement("span");
			counts.textContent = prog.done + " / " + prog.total + " lessons";
			meta.appendChild(counts);
			var cta = document.createElement("span");
			cta.className = "learn-course-cta";
			cta.textContent = locked ? "Finish previous course →" : (done ? "Review →" : (prog.done > 0 ? "Continue →" : "Start →"));
			meta.appendChild(cta);
			card.appendChild(meta);

			card.addEventListener("click", function() { if (!locked) enterCourse(c.id); });
			list.appendChild(card);
		})(i);
	}
}

function renderLearnCourse(course) {
	var titleEl = document.getElementById("learn_course_title");
	var subEl = document.getElementById("learn_course_sub");
	var container = document.getElementById("learn_lesson_container");
	var stepper = document.getElementById("learn_stepper");
	var navEl = document.getElementById("learn_nav");
	var doneCard = document.getElementById("learn_complete");
	if (!container || !stepper || !navEl || !doneCard) return;

	titleEl.textContent = course.title;
	subEl.textContent = course.sub;

	var completed = learnState.completed[course.id];
	var lessons = course.lessons;

	// Course-complete screen takes over when currentLesson is past the end.
	if (courseIsComplete(course.id) && learnState.currentLesson >= lessons.length) {
		container.innerHTML = "";
		stepper.innerHTML = "";
		navEl.innerHTML = "";
		doneCard.style.display = "";
		document.getElementById("learn_complete_title").textContent = course.title + " — complete!";
		document.getElementById("learn_complete_body").textContent = "You've finished every lesson in this course.";
		var actions = document.getElementById("learn_complete_actions");
		actions.innerHTML = "";
		var courseIdx = LEARN_COURSES.indexOf(course);
		var nextCourse = LEARN_COURSES[courseIdx + 1];
		if (nextCourse) {
			var nextBtn = document.createElement("button");
			nextBtn.type = "button";
			nextBtn.className = "btn btn-primary";
			nextBtn.textContent = "Start " + nextCourse.title + " →";
			nextBtn.addEventListener("click", function() { enterCourse(nextCourse.id); });
			actions.appendChild(nextBtn);
		}
		var backBtn = document.createElement("button");
		backBtn.type = "button";
		backBtn.className = "btn btn-secondary";
		backBtn.textContent = "All courses";
		backBtn.addEventListener("click", exitToCourseList);
		actions.appendChild(backBtn);
		var reviewBtn = document.createElement("button");
		reviewBtn.type = "button";
		reviewBtn.className = "btn btn-ghost";
		reviewBtn.textContent = "Review this course";
		reviewBtn.addEventListener("click", function() {
			learnState.currentLesson = 0;
			saveLearnState();
			renderLearn();
		});
		actions.appendChild(reviewBtn);
		return;
	}
	doneCard.style.display = "none";

	function renderStepper() {
		stepper.innerHTML = "";
		var courseDone = courseIsComplete(course.id);
		for (var i = 0; i < lessons.length; i++) {
			(function(idx) {
				var step = document.createElement("button");
				step.type = "button";
				step.className = "learn-step";
				step.textContent = String(idx + 1);
				step.title = lessons[idx].title;
				if (completed[idx]) step.classList.add("done");
				if (idx === learnState.currentLesson) step.classList.add("current");
				var unlocked = courseDone || completed[idx] || idx <= learnState.currentLesson;
				if (unlocked) step.classList.add("unlocked");
				step.disabled = !unlocked;
				step.addEventListener("click", function() {
					if (!unlocked) return;
					learnState.currentLesson = idx;
					saveLearnState();
					renderLearn();
				});
				stepper.appendChild(step);
				if (idx < lessons.length - 1) {
					var line = document.createElement("span");
					line.className = "learn-step-line" + (completed[idx] ? " done" : "");
					stepper.appendChild(line);
				}
			})(i);
		}
	}

	function renderNav() {
		navEl.innerHTML = "";
		var prev = document.createElement("button");
		prev.type = "button";
		prev.className = "btn btn-secondary";
		prev.textContent = "← Previous lesson";
		prev.disabled = learnState.currentLesson === 0;
		prev.addEventListener("click", function() {
			if (learnState.currentLesson > 0) { learnState.currentLesson--; saveLearnState(); renderLearn(); }
		});
		navEl.appendChild(prev);

		var progress = document.createElement("div");
		progress.className = "learn-progress-text";
		var prog = courseProgress(course.id);
		progress.textContent = prog.done + " of " + prog.total + " complete";
		navEl.appendChild(progress);

		var next = document.createElement("button");
		next.type = "button";
		next.className = "btn btn-primary";
		var isLast = learnState.currentLesson === lessons.length - 1;
		next.textContent = isLast ? "Finish course" : "Next lesson →";
		next.disabled = !completed[learnState.currentLesson];
		next.addEventListener("click", function() {
			if (next.disabled) return;
			if (isLast) {
				learnState.currentLesson = lessons.length;
				if (!learnState.completedAt[course.id]) learnState.completedAt[course.id] = Date.now();
			} else {
				learnState.currentLesson++;
			}
			saveLearnState();
			renderLearn();
		});
		navEl.appendChild(next);
	}

	renderStepper();

	// Lesson content. On puzzle-completion we only refresh the stepper + nav so
	// the lesson card (and its solved puzzle state) stays intact.
	// Dispatches on lesson shape: `steps` means the new mentor-guided format (a sequence of
	// interactive boards coached by one instructor panel — see buildMentorLesson); `puzzles` means
	// the older prose-plus-practice-puzzles format (buildLearnLesson) that courses not yet ported
	// still use. Both take the same (lesson, idx, total, onLessonComplete) signature.
	container.innerHTML = "";
	var lesson = lessons[learnState.currentLesson];
	var buildLesson = lesson.steps ? buildMentorLesson : buildLearnLesson;
	container.appendChild(buildLesson(lesson, learnState.currentLesson, lessons.length, function() {
		if (!completed[learnState.currentLesson]) {
			completed[learnState.currentLesson] = true;
			if (courseIsComplete(course.id) && !learnState.completedAt[course.id]) {
				learnState.completedAt[course.id] = Date.now();
			}
		}
		if (lesson.steps) {
			// Mentor lessons: Continue on the final step should always visibly go somewhere — straight
			// to the next lesson, or the course-complete screen — the same as clicking Next lesson
			// would, rather than leaving the player on a finished board with nothing obviously left to
			// click (this was the actual "Continue doesn't do anything" bug: on a lesson with only one
			// or two steps, most Continue clicks land on the LAST step, where the old behaviour was
			// just a quiet stepper/nav refresh with no visible change at all). Older-format lessons
			// (buildLearnLesson) keep their original behaviour — stay put so the player can review
			// their solved puzzles, advancing only when they click Next lesson themselves.
			if (learnState.currentLesson < lessons.length - 1) {
				learnState.currentLesson++;
			} else {
				learnState.currentLesson = lessons.length;
			}
			saveLearnState();
			renderLearn();
		} else {
			saveLearnState();
			renderStepper();
			renderNav();
		}
	}));

	renderNav();
}

function wireLearnControls() {
	var back = document.getElementById("learn_back_home");
	if (back && !back.dataset.wired) {
		back.dataset.wired = "1";
		back.addEventListener("click", exitToCourseList);
	}
}

document.addEventListener("DOMContentLoaded", function() {
	loadLearnState();
	wireLearnControls();
});
if (document.readyState !== "loading") {
	loadLearnState();
	wireLearnControls();
}

function buildLearnLesson(lesson, idx, total, onLessonComplete) {
	var card = document.createElement("div");
	card.className = "section-card learn-lesson learn-lesson-open";

	var title = document.createElement("h2");
	title.className = "learn-lesson-title";
	title.style.fontSize = "1.4rem";
	title.style.margin = "0 0 0.35rem";
	title.textContent = lesson.title;
	card.appendChild(title);

	var idea = document.createElement("p");
	idea.className = "learn-lesson-idea";
	idea.style.fontSize = "1rem";
	idea.style.color = "var(--text)";
	idea.style.margin = "0 0 0.85rem";
	idea.textContent = lesson.idea;
	card.appendChild(idea);

	var body = document.createElement("div");
	body.className = "learn-lesson-body";
	var how = document.createElement("p");
	how.className = "learn-how";
	how.textContent = lesson.how;
	body.appendChild(how);
	if (lesson.mistake) {
		var mistake = document.createElement("p");
		mistake.className = "learn-mistake";
		var strong = document.createElement("strong");
		strong.textContent = "Watch out: ";
		mistake.appendChild(strong);
		mistake.appendChild(document.createTextNode(lesson.mistake));
		body.appendChild(mistake);
	}

	var demos = Array.isArray(lesson.demo) ? lesson.demo : (lesson.demo ? [lesson.demo] : []);
	for (var di = 0; di < demos.length; di++) {
		body.appendChild(buildLearnDemo(demos[di]));
	}

	if (lesson.puzzles.length > 0) {
		var tryLabel = document.createElement("div");
		tryLabel.className = "learn-try-label";
		tryLabel.textContent = lesson.puzzles.length > 1 ? "Now you try" : "Your turn";
		body.appendChild(tryLabel);
	}

	var puzzleSolved = lesson.puzzles.map(function() { return false; });
	function markSolved(puzzleIdx) {
		puzzleSolved[puzzleIdx] = true;
		var done = puzzleSolved.every(function(b) { return b; });
		if (done && typeof onLessonComplete === "function") onLessonComplete();
	}

	for (var p = 0; p < lesson.puzzles.length; p++) {
		(function(pi) {
			body.appendChild(buildLearnPuzzle(lesson.puzzles[pi], !!lesson.guess, function() {
				markSolved(pi);
			}));
		})(p);
	}
	card.appendChild(body);
	return card;
}

// A small friendly "coach" mascot for the mentor lesson panel — the game's own iconic spiky mine
// (see buildAvatarCanvas's "mine" case, BoardRender.js), drawn bigger and given a face, so the
// character teaching you about mines is, fittingly, one. Same sphere/spike/shine construction as
// that avatar, just larger and with two eyes + a smile it doesn't have there.
function buildCoachAvatar(px) {
	px = px || 96;
	var dpr = window.devicePixelRatio || 1;
	var c = document.createElement("canvas");
	c.className = "learn-mentor-avatar";
	c.width = Math.round(px * dpr);
	c.height = Math.round(px * dpr);
	c.style.width = px + "px";
	c.style.height = px + "px";
	var ctx = c.getContext("2d");
	ctx.scale(dpr, dpr);

	var cx = px * 0.5, cy = px * 0.52, rad = px * 0.34;
	ctx.strokeStyle = "#475569";
	ctx.lineWidth = Math.max(1.5, rad * 0.22);
	ctx.lineCap = "round";
	for (var i = 0; i < 8; i++) {
		var a = i * Math.PI / 4 + Math.PI / 8;
		ctx.beginPath();
		ctx.moveTo(cx + Math.cos(a) * rad * 0.88, cy + Math.sin(a) * rad * 0.88);
		ctx.lineTo(cx + Math.cos(a) * rad * 1.4, cy + Math.sin(a) * rad * 1.4);
		ctx.stroke();
	}
	var g = ctx.createLinearGradient(0, cy - rad, 0, cy + rad);
	g.addColorStop(0, "#3b4a68"); g.addColorStop(1, "#0b1220");
	ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
	ctx.fillStyle = g; ctx.fill();
	ctx.lineWidth = Math.max(1, px * 0.015);
	ctx.strokeStyle = "rgba(148,163,184,0.45)"; ctx.stroke();

	// Face: two round eyes + a curved smile — this is the only thing that distinguishes it from
	// the plain in-game mine icon, so it carries all of the "friendly" reading.
	var eyeY = cy - rad * 0.05, eyeDx = rad * 0.32, eyeR = rad * 0.14;
	ctx.fillStyle = "#e6e9f5";
	ctx.beginPath(); ctx.arc(cx - eyeDx, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
	ctx.beginPath(); ctx.arc(cx + eyeDx, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
	ctx.fillStyle = "#0b1020";
	var pupilR = eyeR * 0.5;
	ctx.beginPath(); ctx.arc(cx - eyeDx, eyeY, pupilR, 0, Math.PI * 2); ctx.fill();
	ctx.beginPath(); ctx.arc(cx + eyeDx, eyeY, pupilR, 0, Math.PI * 2); ctx.fill();
	ctx.strokeStyle = "#e6e9f5";
	ctx.lineWidth = Math.max(1.2, rad * 0.07);
	ctx.lineCap = "round";
	ctx.beginPath();
	ctx.arc(cx, cy + rad * 0.24, rad * 0.3, 0.15 * Math.PI, 0.85 * Math.PI);
	ctx.stroke();
	return c;
}

// Mentor-guided lesson: a SEQUENCE of interactive boards (each built with the exact same
// buildLearnPuzzle every other real board on the site uses — chord/cascade/flag all behave
// identically, nothing here reimplements them), coached by a mascot in a speech bubble ABOVE the
// board, Duolingo-style — one message on screen at a time, replaced by whatever's relevant next,
// rather than a running transcript. Instruction-then-board top-to-bottom, not side by side: with the
// coach off to the side, attention naturally stays on the board and the text goes unread. Progress
// is button-gated, not automatic — solving a step shows a Continue button (advancing only stays a
// deliberate act the player takes, not something that happens mid-click), and a hard failure (a mine
// hit outside a clickMine step) shows Try again instead of leaving a dead board with no way back in.
// There's no separate Reset — Try again (on failure) and re-entering a lesson (via the stepper) are
// the only ways back to a clean board, so there's exactly one way to redo something, not two. A
// lesson object:
//   steps: [ {...}, {...} ]  — one entry per board, in order; each entry:
//     board: {...}             — a normal buildLearnPuzzle board spec (rows/cols/mines/revealStart/
//                                 mustFlag/chordOnly/clickMine/guess/goodGuessCells/...)
//     requirements: {...}      — optional extra win condition, see buildLearnPuzzle's own comment
//     intro: "..." | ["...", ...]  — what the coach says when this step loads (joined into one bubble)
//     hints: ["...", ...]      — revealed one at a time by the Hint button, most specific last
//     mistakes: { mine: "...", wrongFlag: "..." }  — shown when that mistake happens
//     outro: "..."             — shown once this step is solved, before Continue advances
function buildMentorLesson(lesson, idx, total, onLessonComplete) {
	var card = document.createElement("div");
	card.className = "section-card learn-mentor";

	var title = document.createElement("h2");
	title.className = "learn-mentor-title";
	title.textContent = lesson.title;
	card.appendChild(title);

	var coach = document.createElement("div");
	coach.className = "learn-mentor-coach";
	card.appendChild(coach);

	coach.appendChild(buildCoachAvatar(64));

	var bubbleCol = document.createElement("div");
	bubbleCol.className = "learn-mentor-bubble-col";
	coach.appendChild(bubbleCol);

	var bubble = document.createElement("div");
	bubble.className = "learn-mentor-bubble";
	bubbleCol.appendChild(bubble);

	var bubbleText = document.createElement("div");
	bubbleText.className = "learn-mentor-bubble-text";
	bubble.appendChild(bubbleText);

	// Replaces whatever the coach was saying — Duolingo-style, one thing on screen at a time — rather
	// than appending to a running transcript. `kind` re-tints the bubble (see the CSS) so a hint,
	// a mistake, and an outro each read a little differently even though it's the same one bubble.
	function say(text, kind) {
		if (!text) return;
		bubbleText.textContent = text;
		bubble.className = "learn-mentor-bubble" + (kind ? " learn-mentor-bubble-" + kind : "");
	}

	var boardCol = document.createElement("div");
	boardCol.className = "learn-mentor-board-col";
	card.appendChild(boardCol);

	var actions = document.createElement("div");
	actions.className = "learn-mentor-actions";
	card.appendChild(actions);

	var steps = lesson.steps || [];
	var stepIdx = 0;
	var hintBtn = null; // rebuilt fresh per step, since each step has its own hints[]

	function loadStep(i) {
		stepIdx = i;
		var step = steps[i];
		actions.innerHTML = "";

		var introLines = Array.isArray(step.intro) ? step.intro : (step.intro ? [step.intro] : []);
		say(introLines.join(" "), "intro");

		if (hintBtn) { hintBtn.remove(); hintBtn = null; }
		var hints = step.hints || [];
		var hintIdx = 0;
		if (hints.length) {
			hintBtn = document.createElement("button");
			hintBtn.type = "button";
			hintBtn.className = "btn btn-ghost learn-mentor-hint-btn";
			hintBtn.textContent = "Hint";
			hintBtn.addEventListener("click", function() {
				if (hintIdx >= hints.length) return;
				say(hints[hintIdx], "hint");
				hintIdx++;
				if (hintIdx >= hints.length) hintBtn.disabled = true;
			});
			bubbleCol.appendChild(hintBtn);
		}

		function onStepSolved() {
			say(step.outro, "outro");
			if (hintBtn) hintBtn.disabled = true;
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn btn-primary learn-mentor-continue-btn";
			btn.textContent = "Continue";
			btn.addEventListener("click", function() {
				if (i + 1 < steps.length) {
					loadStep(i + 1);
				} else {
					actions.innerHTML = "";
					if (typeof onLessonComplete === "function") onLessonComplete();
				}
			});
			actions.innerHTML = "";
			actions.appendChild(btn);
			btn.focus();
		}
		function onStepFailed() {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.className = "btn btn-secondary learn-mentor-tryagain-btn";
			btn.textContent = "Try again";
			// Simplest correct reset: reload this exact step from scratch — a fresh buildLearnPuzzle
			// instance, fresh hint progress, the intro said again — rather than trying to surgically
			// rewind the old one's internal state.
			btn.addEventListener("click", function() { loadStep(i); });
			actions.innerHTML = "";
			actions.appendChild(btn);
			btn.focus();
		}
		function onStepMistake(kind, info) {
			say(step.mistakes && step.mistakes[kind], "mistake");
		}

		boardCol.innerHTML = "";
		// A pure explanation step (no puzzle to solve) — e.g. the "two rules" reference panel.
		// Continue shows immediately, and — unlike onStepSolved — leaves the intro text alone
		// instead of overwriting it with an outro the player never got a chance to read.
		if (step.rulesPanel) {
			boardCol.appendChild(buildRulesPanel(step.rulesPanel));
			var contBtn = document.createElement("button");
			contBtn.type = "button";
			contBtn.className = "btn btn-primary learn-mentor-continue-btn";
			contBtn.textContent = "Continue";
			contBtn.addEventListener("click", function() {
				if (i + 1 < steps.length) {
					loadStep(i + 1);
				} else {
					actions.innerHTML = "";
					if (typeof onLessonComplete === "function") onLessonComplete();
				}
			});
			actions.innerHTML = "";
			actions.appendChild(contBtn);
			contBtn.focus();
			return;
		}
		var puzzle = Object.assign({ title: lesson.title }, step.board, { requirements: step.requirements });
		boardCol.appendChild(buildLearnPuzzle(puzzle, !!step.guess, onStepSolved, onStepFailed, onStepMistake));
	}

	if (steps.length) loadStep(0);
	return card;
}

// One scene of a rule demo: highlight a clue cell, then flag or reveal its covered neighbours
// one at a time, hold, reset, and loop — on its own, independent of any other scene. A rule with
// cycles through every scene on one shared board (see buildRuleDemo) rather than each scene
// getting its own canvas — building a BoardView bound to a caller-supplied canvas instead of
// creating its own, so buildRuleDemo can sweep between two scenes' views on the same surface.
// spec: { rows, cols, mines, revealed, flagged, clueCell: [r,c], targets: [[r,c]...],
//         action: "flag" | "reveal", revealFrom: [r,c] }
// Returns { bv, play } — nothing is drawn or animated until the caller calls play(); the
// caller decides when this scene's board is actually visible on the canvas (mid-sweep, its
// content is composited alongside another scene's, so drawing early would race that).
// revealFrom (reveal scenes only) triggers a real BoardLogic.cascadeReveal from that single
// cell instead of stepping through `targets` one at a time — for a scene where the reveal is
// genuinely a cascade (one click opening several 0-cells' worth of neighbours), this reuses the
// exact algorithm a real click runs rather than a hand-authored stand-in for it. Scenes whose
// reveal is just "this clue's remaining covered neighbours, not a cascade" keep using `targets`.
function buildRuleDemoScene(canvas, spec, onDone) {
	var R = spec.rows, C = spec.cols;
	var isMineArr = buildMineGrid(spec);
	var clueValue = BoardLogic.buildClueGrid(R, C, function(r, c) { return isMineArr[r][c]; });
	var state = buildBoardState(spec, isMineArr, clueValue);

	var highlightCell = null;
	var bv = learnBoardView(canvas, spec, isMineArr, clueValue, state);
	bv.overlay(function(ctx, sw, sh) {
		if (!highlightCell) return;
		var hx = highlightCell[1] * sw + sw * 0.08;
		var hy = highlightCell[0] * sh + sh * 0.08;
		ctx.save();
		ctx.lineWidth = Math.max(2, Math.min(sw, sh) * 0.08);
		ctx.strokeStyle = "rgba(250, 204, 21, 0.95)";
		ctx.shadowColor = "rgba(250, 204, 21, 0.7)";
		ctx.shadowBlur = Math.min(sw, sh) * 0.25;
		ctx.strokeRect(hx, hy, sw * 0.84, sh * 0.84);
		ctx.restore();
	});

	var targets = spec.targets || [];
	var targetState = spec.action === "flag" ? FLAGGED : KNOWN;

	// Stops once this canvas is no longer on the page (the player moved on to another step)
	// instead of ticking forever in the background.
	function playFrom(i) {
		if (!canvas.isConnected) return;
		if (i === 0) {
			highlightCell = spec.clueCell;
			bv.draw();
			setTimeout(function() { playFrom(1); }, 750);
			return;
		}
		if (spec.revealFrom) {
			if (i === 1) {
				BoardLogic.cascadeReveal(spec.revealFrom[0], spec.revealFrom[1], R, C,
					function(rr, cc) { return state[rr][cc] === UNKNOWN && !isMineArr[rr][cc]; },
					function(rr, cc) { state[rr][cc] = KNOWN; return false; },
					function(rr, cc) { return clueValue[rr][cc]; });
				bv.draw();
			}
			setTimeout(function() {
				if (!canvas.isConnected) return;
				if (typeof onDone === "function") onDone();
			}, 700);
			return;
		}
		var idx = i - 1;
		if (idx < targets.length) {
			var t = targets[idx];
			state[t[0]][t[1]] = targetState;
			bv.draw();
			setTimeout(function() { playFrom(i + 1); }, 650);
			return;
		}
		setTimeout(function() {
			if (!canvas.isConnected) return;
			if (typeof onDone === "function") onDone();
		}, 700);
	}

	return { bv: bv, play: function() { playFrom(0); } };
}

// Wipes a shared demo canvas from one scene's board to another, reusing the same "go" sweep the
// live board plays when a countdown starts (paintBoardGoAnimation/BOARD_GO_STYLE, normally seen
// transitioning a board from idle to ready): a glowing band sweeps top to bottom, and rows it has
// already passed show the new scene while rows still ahead show the old one — so the board reads
// as wiping from the old example (below the band) to the new one (above it), not cutting instantly.
// oldBv/newBv are BoardViews already bound to `canvas` (see buildRuleDemoScene); both scenes must
// share canvas's rows/cols, since a single sweep frame draws both onto the same cell grid.
function sweepRuleDemo(canvas, rows, cols, oldBv, newBv, onDone) {
	var ctx = canvas.getContext("2d");
	var sw = canvas.width / cols, sh = canvas.height / rows;
	var start = performance.now();
	var duration = Math.max(50, BOARD_GO_STYLE.durationMs);
	var width = Math.max(0.5, BOARD_GO_STYLE.width);
	var maxP = boardGoAxisMax("rowWipe", rows, cols);

	function paintSplit(frontP) {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		setPaletteVars(localBoardSkin);
		for (var r = 0; r < rows; r++) {
			var view = r < frontP ? newBv : oldBv;
			for (var c = 0; c < cols; c++) drawCell(ctx, r, c, view, sw, sh, null);
		}
	}

	function frame() {
		if (!canvas.isConnected) return;
		var elapsed = performance.now() - start;
		if (elapsed >= duration) {
			paintSplit(maxP + width + 1); // past every row: the whole board now reads as "new"
			if (typeof onDone === "function") onDone();
			return;
		}
		var frontP = (elapsed / duration) * (maxP + width * 2) - width;
		paintSplit(frontP);
		paintBoardGoAnimation(ctx, sw, sh, rows, cols, { start: start }, null);
		requestAnimationFrame(frame);
	}
	frame();
}

// Cycles a rule's demo scenes one after another on a single shared board, sweeping between them
// (sweepRuleDemo) instead of cutting instantly. All of a rule's scenes must share one rows/cols —
// a sweep frame composites two scenes' views onto the same cell grid, so they can't differ in size.
function buildRuleDemo(scenes) {
	var wrap = document.createElement("div");
	wrap.className = "learn-board learn-rule-demo-board";
	var R = scenes[0].rows, C = scenes[0].cols;
	var canvas = buildBoardCanvas(R, C);
	wrap.appendChild(canvas);

	var current = null;

	function showScene(idx) {
		current = buildRuleDemoScene(canvas, scenes[idx], function() { advance(idx); });
		current.bv.draw();
		current.play();
	}

	function advance(idx) {
		setTimeout(function() {
			if (!canvas.isConnected) return;
			var nextIdx = (idx + 1) % scenes.length;
			if (scenes.length < 2) { showScene(nextIdx); return; }
			var next = buildRuleDemoScene(canvas, scenes[nextIdx], function() { advance(nextIdx); });
			sweepRuleDemo(canvas, R, C, current.bv, next.bv, function() {
				current = next;
				current.play();
			});
		}, 300);
	}

	// Deferred, not called directly: buildRuleDemo returns wrap before the caller inserts it into
	// the document, so canvas.isConnected would still be false on an immediate call — the very
	// guard meant to stop the loop once torn down would instead stop it before it ever started.
	setTimeout(function() { showScene(0); }, 50);

	return wrap;
}

// The "two rules" reference panel — a rulesPanel step's board area. Two cards side by side (each
// labelled Rule #1 / Rule #2, matching the mentor's spoken intro), each cycling through its
// example(s) on one shared board (buildRuleDemo) so the rule is something you watch happen, not
// just a sentence to read.
function buildRulesPanel(spec) {
	var wrap = document.createElement("div");
	wrap.className = "learn-rules-panel";
	(spec.rules || []).forEach(function(rule) {
		var card = document.createElement("div");
		card.className = "learn-rule-card";
		var label = document.createElement("div");
		label.className = "learn-rule-card-label";
		label.textContent = rule.label;
		card.appendChild(label);
		var desc = document.createElement("div");
		desc.className = "learn-rule-card-desc";
		desc.textContent = rule.desc;
		card.appendChild(desc);
		card.appendChild(buildRuleDemo(rule.demos));
		wrap.appendChild(card);
	});
	return wrap;
}

// Render a demo grid to a canvas. Demos are static — the grid token IS the
// display: `0-8` = revealed clue with that value, `?` = revealed empty,
// `.` = covered, `*` = flagged, `b` = revealed mine, `m` = covered mine
// shown via x-ray. A solution `M` on a `.` cell also promotes it to an
// x-ray mine (existing demos use that convention). S/G/B are no longer
// drawn — demos don't decorate cells with checkmarks anymore.
var LEARN_CELL_PX = 32;

// ---- Lesson + demo + puzzle rendering ---------------------------------
// A "lesson" object: { title, idea, how, demo, puzzles[] }. Each demo and
// each puzzle uses the same data shape:
//   rows, cols                 — board dimensions
//   mines: [[r,c]...]          — mine positions
//   flagged: [[r,c]...]        — cells pre-flagged at the start
//   revealStart: [r,c]         — cascade-reveal from this cell
//   revealAll: true            — reveal every non-mine cell at the start
//   revealed: [[r,c]...]       — explicit cells to start revealed
//   covered: [[r,c]...]        — overrides cells back to covered (used with revealAll)
//   xray: true                 — render mines through the cover (demos)
//   chordOnly: true            — block left-click on covered (chord lesson)
//   mustFlag: true             — puzzle solved when every mine is flagged
//   guess: true + goodGuessCells: [[r,c]...] — smart-guessing puzzles
//   why: "..."                 — explanation text (demos)

function buildBoardState(spec, isMineArr, clueValue) {
	var R = spec.rows, C = spec.cols;
	// Aliases onto the canonical BoardLogic sentinels (one board encoding everywhere).
	var COVERED = UNKNOWN, REVEALED = KNOWN, FLAGGED_S = FLAGGED;
	var s = [];
	for (var r = 0; r < R; r++) s[r] = new Array(C).fill(COVERED);
	if (spec.revealAll) {
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (!isMineArr[r][c]) s[r][c] = REVEALED;
		}
	}
	(spec.revealed || []).forEach(function(p) { s[p[0]][p[1]] = REVEALED; });
	(spec.covered || []).forEach(function(p) { s[p[0]][p[1]] = COVERED; });
	(spec.flagged || []).forEach(function(p) { s[p[0]][p[1]] = FLAGGED_S; });
	if (spec.revealStart) {
		BoardLogic.cascadeReveal(spec.revealStart[0], spec.revealStart[1], R, C,
			function(rr, cc) { return s[rr][cc] === COVERED && !isMineArr[rr][cc]; },
			function(rr, cc) { s[rr][cc] = REVEALED; return false; },
			function(rr, cc) { return clueValue[rr][cc]; }
		);
	}
	return s;
}

// A BoardView for a Learn board: cellAt reads the mine grid (→ MINE) then the
// clue grid. The caller supplies the canvas and the (mutable) state matrix.
function learnBoardView(canvas, spec, isMineArr, clueValue, state) {
	return new BoardView(canvas, spec.rows, spec.cols, state,
		function(r, c) { return isMineArr[r][c] ? MINE : clueValue[r][c]; },
		{ xray: spec.xray, skin: spec.skin || null });
}

function buildBoardCanvas(R, C) {
	return buildCellCanvas(C, R, LEARN_CELL_PX);
}

function buildMineGrid(spec) {
	var R = spec.rows, C = spec.cols;
	var arr = [];
	for (var r = 0; r < R; r++) arr[r] = new Array(C).fill(false);
	(spec.mines || []).forEach(function(m) { arr[m[0]][m[1]] = true; });
	return arr;
}

function renderDemoBoard(demo) {
	var R = demo.rows, C = demo.cols;
	var isMineArr = buildMineGrid(demo);
	var clueValue = BoardLogic.buildClueGrid(R, C, function(r, c) { return isMineArr[r][c]; });
	var state = buildBoardState(demo, isMineArr, clueValue);
	var wrap = document.createElement("div");
	wrap.className = "learn-board";
	var canvas = buildBoardCanvas(R, C);
	wrap.appendChild(canvas);
	learnBoardView(canvas, demo, isMineArr, clueValue, state).draw();
	return wrap;
}

function buildLearnDemo(demo) {
	var wrap = document.createElement("div");
	wrap.className = "learn-demo";

	var label = document.createElement("div");
	label.className = "learn-demo-label";
	label.textContent = demo.title || "Worked example";
	wrap.appendChild(label);

	if (demo.tiles) {
		var tilesWrap = document.createElement("div");
		tilesWrap.className = "learn-demo-tiles";
		demo.tiles.forEach(function(tile) { tilesWrap.appendChild(renderDemoBoard(tile)); });
		wrap.appendChild(tilesWrap);
	} else {
		wrap.appendChild(renderDemoBoard(demo));
	}

	if (demo.why) {
		var why = document.createElement("div");
		why.className = "learn-demo-why";
		why.textContent = demo.why;
		wrap.appendChild(why);
	}

	return wrap;
}

// Interactive puzzle. Mouse + right-click on the canvas drive standard
// minesweeper interactions through cellFromCanvas (defined in Input.js).
// Objective is "open all safe cells" by default; mustFlag/guess/clickMine change it.
// Optional puzzle.requirements ({ minCascades, minChords }) adds an extra condition on top of that
// base objective — e.g. the board must be cleared using at least one real cascade, not just clicked
// open cell by cell. Optional onMistake(kind, info) — "mine" | "wrongFlag" — is called alongside
// onFailed (mine hit only) so a caller can react to specific error types, not just "you lost";
// existing callers that don't pass it are unaffected. puzzle.clickMine flips the mine-hit rule
// entirely — the objective becomes clicking a mine on purpose (the very first thing the "Rules of
// the game" course does, so the player sees what a mine actually looks like before being told to
// avoid it) — no onFailed/onMistake/gameOver on that hit, it's the win condition.
function buildLearnPuzzle(puzzle, isGuess, onSolved, onFailed, onMistake) {
	var wrap = document.createElement("div");
	wrap.className = "learn-puzzle";
	var title = document.createElement("span");
	title.className = "learn-puzzle-title";
	title.textContent = puzzle.title;
	var solvedTick = document.createElement("span");
	solvedTick.className = "learn-puzzle-solved";
	solvedTick.textContent = "";
	title.appendChild(solvedTick);
	wrap.appendChild(title);

	var R = puzzle.rows, C = puzzle.cols;
	// Aliases onto the canonical BoardLogic sentinels; the play logic below mutates
	// `state` with these (FLAGGED is the global sentinel). One board encoding everywhere.
	var COVERED = UNKNOWN, REVEALED = KNOWN;

	var isMineArr = buildMineGrid(puzzle);
	var clueValue = BoardLogic.buildClueGrid(R, C, function(r, c) { return isMineArr[r][c]; });
	var state = buildBoardState(puzzle, isMineArr, clueValue);

	var boardWrap = document.createElement("div");
	boardWrap.className = "learn-board";
	var canvas = buildBoardCanvas(R, C);
	canvas.style.cursor = "pointer";
	boardWrap.appendChild(canvas);
	wrap.appendChild(boardWrap);

	// highlightedCells can be either:
	//   * an array of [r,c] (single gold-outlined group, the simple case), or
	//   * an object { primary: [...], context: [...] } where primary draws
	//     gold and context draws softer blue — used to visualize a proof
	//     step against the cells of its parent clues.
	var highlightedCells = null;
	function drawOutlines(ctx, sw, sh, cells, stroke, shadow) {
		if (!cells || !cells.length) return;
		ctx.save();
		ctx.lineWidth = Math.max(2, Math.min(sw, sh) * 0.08);
		ctx.strokeStyle = stroke;
		ctx.shadowColor = shadow;
		ctx.shadowBlur = Math.min(sw, sh) * 0.25;
		for (var hi = 0; hi < cells.length; hi++) {
			var hc = cells[hi];
			var hx = hc[1] * sw + sw * 0.08;
			var hy = hc[0] * sh + sh * 0.08;
			ctx.strokeRect(hx, hy, sw * 0.84, sh * 0.84);
		}
		ctx.restore();
	}
	// The board renders itself; the highlight overlay reads the live `highlightedCells`.
	var bv;
	function buildBoardRenderer() {
		bv = learnBoardView(canvas, puzzle, isMineArr, clueValue, state);
		bv.overlay(function(ctx, sw, sh) {
			if (!highlightedCells) return;
			if (Array.isArray(highlightedCells)) {
				drawOutlines(ctx, sw, sh, highlightedCells, "rgba(250, 204, 21, 0.95)", "rgba(250, 204, 21, 0.7)");
			} else {
				// Context drawn first so primary outlines sit on top.
				drawOutlines(ctx, sw, sh, highlightedCells.context, "rgba(96, 165, 250, 0.85)", "rgba(96, 165, 250, 0.5)");
				drawOutlines(ctx, sw, sh, highlightedCells.primary, "rgba(250, 204, 21, 0.95)", "rgba(250, 204, 21, 0.7)");
			}
		});
	}
	buildBoardRenderer();
	function renderAll() { bv.draw(); }
	renderAll();

	var status = document.createElement("span");
	status.className = "learn-status";

	var puzzleSolved = false, gameOver = false;
	// Tallies for puzzle.requirements — see the function's own comment above.
	var cascadeCount = 0, chordCount = 0;

	function setStatus(text, cls) {
		status.textContent = text;
		status.className = "learn-status" + (cls ? " " + cls : "");
	}

	// True once every requirement in puzzle.requirements is met (vacuously true with none set) —
	// checked ON TOP OF the base clear/flag condition in checkSolved, never instead of it.
	function requirementsMet() {
		var req = puzzle.requirements;
		if (!req) return true;
		if (typeof req.minCascades === "number" && cascadeCount < req.minCascades) return false;
		if (typeof req.minChords === "number" && chordCount < req.minChords) return false;
		return true;
	}

	function notifySolved() {
		if (puzzleSolved) return;
		puzzleSolved = true;
		solvedTick.textContent = "✓";
		if (typeof onSolved === "function") onSolved();
	}

	function progressStatus() {
		if (isGuess) { setStatus("", ""); return; }
		if (puzzle.clickMine) { setStatus("", ""); return; }
		if (puzzle.mustFlag) {
			var total = (puzzle.mines || []).length, flagged = 0;
			(puzzle.mines || []).forEach(function(m) { if (state[m[0]][m[1]] === FLAGGED) flagged++; });
			setStatus(flagged + " / " + total + " mines flagged", "");
			return;
		}
		var total = 0, opened = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (!isMineArr[r][c]) {
				total++;
				if (state[r][c] === REVEALED) opened++;
			}
		}
		setStatus(opened + " / " + total + " safe cells opened", "");
	}

	function checkSolved() {
		if (puzzleSolved || gameOver) return;
		if (puzzle.clickMine) return; // resolved directly from revealCell's mine-hit branch below
		if (isGuess) {
			var goodList = puzzle.goodGuessCells || [];
			for (var i = 0; i < goodList.length; i++) {
				if (state[goodList[i][0]][goodList[i][1]] === REVEALED) {
					setStatus("Good guess — lowest risk on the board.", "ok");
					notifySolved();
					return;
				}
			}
			return;
		}
		var allOk = true;
		if (puzzle.mustFlag) {
			for (var i = 0; i < (puzzle.mines || []).length && allOk; i++) {
				var m = puzzle.mines[i];
				if (state[m[0]][m[1]] !== FLAGGED) allOk = false;
			}
		} else {
			for (var r = 0; r < R && allOk; r++) for (var c = 0; c < C && allOk; c++) {
				if (!isMineArr[r][c] && state[r][c] !== REVEALED) allOk = false;
			}
		}
		if (allOk && !requirementsMet()) allOk = false; // cleared, but not the way this lesson asks for
		if (allOk) {
			setStatus("Solved! ✓", "ok");
			notifySolved();
		} else {
			progressStatus();
		}
	}

	function revealCell(r, c) {
		var openedCount = 0, hitMine = false;
		BoardLogic.cascadeReveal(r, c, R, C,
			function(rr, cc) { return state[rr][cc] === COVERED; },
			function(rr, cc) {
				state[rr][cc] = REVEALED;
				openedCount++;
				if (isMineArr[rr][cc]) {
					hitMine = true;
					// puzzle.clickMine flips the usual rule: this ONE puzzle's whole point is
					// clicking the mine on purpose, so hitting it is the win, not a loss — no
					// gameOver, no failure status, no onFailed/onMistake.
					if (puzzle.clickMine) { setStatus("Found it. ✓", "ok"); notifySolved(); return true; }
					gameOver = true;
					setStatus(isGuess ? "Bad guess — the other group has better odds. Reset to try again." : "You hit a mine. Reset to try again.", "warn");
					if (typeof onFailed === "function") onFailed();
					if (typeof onMistake === "function") onMistake("mine", { r: rr, c: cc });
					return true;
				}
				return false;
			},
			function(rr, cc) { return clueValue[rr][cc]; }
		);
		// A cascade is a SINGLE origin click flooding open more than one cell (the 0-clue chain
		// reaction) — a chord opening several individually-satisfied neighbours calls revealCell once
		// per cell below, so each of those calls sees openedCount 1 and correctly doesn't count.
		if (!hitMine && openedCount > 1) cascadeCount++;
		renderAll();
	}

	function tryChord(r, c) {
		if (state[r][c] !== REVEALED) return;
		var v = clueValue[r][c];
		if (v === 0) return;
		var cctx = BoardLogic.chordContext(r, c, R, C,
			function(rr, cc) { return state[rr][cc] === FLAGGED; },
			null,
			function(rr, cc) { return state[rr][cc] === COVERED; }
		);
		if (cctx.flagCount !== v) return;
		chordCount++;
		for (var i = 0; i < cctx.covered.length; i++) revealCell(cctx.covered[i][0], cctx.covered[i][1]);
	}

	function toggleFlag(r, c) {
		if (state[r][c] === COVERED) {
			state[r][c] = FLAGGED;
			if (!isMineArr[r][c] && typeof onMistake === "function") onMistake("wrongFlag", { r: r, c: c });
		}
		else if (state[r][c] === FLAGGED) state[r][c] = COVERED;
		else return;
		renderAll();
	}

	function onLeftClick(r, c) {
		if (gameOver || puzzleSolved) return;
		if (state[r][c] === COVERED) {
			if (puzzle.chordOnly) { setStatus("Chord a satisfied number.", "warn"); return; }
			revealCell(r, c);
		} else if (state[r][c] === REVEALED) tryChord(r, c);
		checkSolved();
	}

	function onRightClick(r, c) {
		if (gameOver || puzzleSolved) return;
		if (state[r][c] === COVERED || state[r][c] === FLAGGED) {
			if (puzzle.chordOnly) { setStatus("Chord a satisfied number.", "warn"); return; }
			toggleFlag(r, c);
		} else if (state[r][c] === REVEALED) tryChord(r, c);
		checkSolved();
	}

	function cellFromEvent(e) { return cellFromCanvas(canvas, R, C, e.clientX, e.clientY); }
	canvas.addEventListener("click", function(e) {
		var cell = cellFromEvent(e);
		if (cell) onLeftClick(cell.r, cell.c);
	});
	canvas.addEventListener("contextmenu", function(e) {
		e.preventDefault();
		var cell = cellFromEvent(e);
		if (cell) onRightClick(cell.r, cell.c);
	});

	function resetPuzzle() {
		state = buildBoardState(puzzle, isMineArr, clueValue);
		buildBoardRenderer();   // rebind the renderer to the fresh state matrix
		gameOver = false;
		puzzleSolved = false;
		cascadeCount = 0;
		chordCount = 0;
		solvedTick.textContent = "";
		setStatus("", "");
		renderAll();
	}

	var controls = document.createElement("div");
	controls.className = "learn-controls";

	var resetBtn = document.createElement("button");
	resetBtn.className = "learn-btn";
	resetBtn.textContent = "Reset";
	resetBtn.addEventListener("click", resetPuzzle);
	controls.appendChild(resetBtn);

	controls.appendChild(status);
	wrap.appendChild(controls);

	// Programmatic controller exposed on the returned element so other
	// callers (e.g. the Analyze modal) can drive the board without
	// going through synthetic clicks.
	wrap._controller = {
		rows: R, cols: C,
		reset: function() { highlightedCells = null; resetPuzzle(); },
		revealCell: function(r, c) { revealCell(r, c); },
		flagCell: function(r, c) {
			if (state[r][c] === COVERED) { state[r][c] = FLAGGED; renderAll(); }
		},
		highlight: function(cells) { highlightedCells = cells || null; renderAll(); },
		cascadeCount: function() { return cascadeCount; },
		chordCount: function() { return chordCount; }
	};

	return wrap;
}
