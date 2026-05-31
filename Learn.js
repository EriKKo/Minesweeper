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
	id: "rules",
	title: "Rules of the game",
	sub: "How to play. Every move you can make.",
	lessons: [
	{
		title: "Reading the numbers",
		idea: "Every number counts the mines in the 8 cells touching it.",
		how: "Left-click a covered cell to open it. Use the numbers around a cell to tell if it's safe.",
		demo: {
			title: "What each number means",
			grid: [
				"1 2 3 3 3 2 1 ? ?",
				"2 b b b b b 2 ? ?",
				"3 b b 6 6 b 5 2 1",
				"3 b b b 4 b b b 2",
				"3 b 7 5 6 b 8 b 3",
				"2 b b b b b b b 2",
				"1 2 3 3 3 3 3 2 1"
			],
			why: "A 1 has one mine next to it. An 8 has eight — every neighbour."
		},
		puzzles: [
			{
				title: "Open the only safe cell",
				grid: [
					"? ? ? ? ? ? ? ? ? ? ? ? ?",
					"? 1 1 1 ? 1 1 1 ? 1 2 2 1",
					"? 1 m 1 ? 1 m 1 ? 1 m m 1",
					"? 1 1 1 ? 1 1 1 ? 1 2 2 1",
					"? 1 1 2 1 1 ? ? ? ? ? ? ?",
					"? 1 m . m 1 ? ? ? ? ? ? ?",
					"? 1 1 2 1 1 ? ? ? ? ? ? ?"
				],
				solution: [
					"? ? ? ? ? ? ? ? ? ? ? ? ?",
					"? 1 1 1 ? 1 1 1 ? 1 2 2 1",
					"? 1 m 1 ? 1 m 1 ? 1 m m 1",
					"? 1 1 1 ? 1 1 1 ? 1 2 2 1",
					"? 1 1 2 1 1 ? ? ? ? ? ? ?",
					"? 1 m S m 1 ? ? ? ? ? ? ?",
					"? 1 1 2 1 1 ? ? ? ? ? ? ?"
				],
				why: "Each ring of 1s circles one mine. The 2s at top-right say two mines sit next to each other. At the bottom, the two 2s above and below the gap mean two mines flank the centre cell — so that centre cell is safe to open. Click it and it reveals a 2."
			}
		]
	},
	{
		title: "Flagging mines",
		idea: "Mark mines with a flag so you don't open them by mistake.",
		how: "Right-click a covered cell to flag it. Right-click again to remove.",
		demo: {
			title: "Marking a mine",
			grid: ["1 1 1", "1 * 1", "1 1 1"],
			why: "Every 1 points at the same mine. Right-click to flag it (🚩)."
		},
		puzzles: [
			{
				title: "Flag every mine you see",
				grid: [
					"? ? ? ? ? ? ? ? ?",
					"? 1 1 1 ? 1 2 2 1",
					"? 1 . 1 ? 1 . . 1",
					"? 1 1 1 ? 1 2 2 1",
					"? ? ? ? ? ? ? ? ?"
				],
				solution: [
					"? ? ? ? ? ? ? ? ?",
					"? 1 1 1 ? 1 2 2 1",
					"? 1 M 1 ? 1 M M 1",
					"? 1 1 1 ? 1 2 2 1",
					"? ? ? ? ? ? ? ? ?"
				]
			}
		]
	},
	{
		title: "Cascades",
		idea: "Opening an empty cell auto-opens its neighbours. Empty neighbours cascade onward — one click can clear half the board.",
		how: "Click somewhere far from any number. Empty cells cascade until they hit a clue.",
		demo: {
			title: "One click, big reveal",
			grid: [
				". ? ? 2 b b 2",
				"? ? ? 2 b b 2",
				"? ? ? 1 2 2 1",
				"? ? ? ? ? ? ?",
				"? ? ? ? ? ? ?"
			],
			solution: [
				"S ? ? 2 b b 2",
				"? ? ? 2 b b 2",
				"? ? ? 1 2 2 1",
				"? ? ? ? ? ? ?",
				"? ? ? ? ? ? ?"
			],
			why: "One click on the empty corner opened the whole left side."
		},
		puzzles: [
			{
				title: "Clear every safe cell",
				grid: [
					"? ? 1 m . . .",
					"? ? 1 . . . .",
					"? ? 1 . . . .",
					"? ? 1 m . . .",
					"? ? 1 . . . .",
					"? 1 1 . . . .",
					"? 1 m . . . ."
				],
				solution: [
					"? ? 1 m S S S",
					"? ? 1 S S S S",
					"? ? 1 S S S S",
					"? ? 1 m S S S",
					"? ? 1 S S S S",
					"? 1 1 S S S S",
					"? 1 m S S S S"
				]
			}
		]
	},
	{
		title: "Chord click",
		idea: "When a number's mines are all flagged, click the number itself to open the rest in one move.",
		how: "Click any number whose flag count matches its value. Left- or right-click both chord.",
		demo: {
			title: "Worked example",
			grid: [
				"1 1 2 1 1",
				"1 * 2 * 1",
				"1 . 3 . 1",
				"? . * . ?",
				"? 1 1 1 ?"
			],
			solution: [
				"1 1 2 1 1",
				"1 * 2 * 1",
				"1 S 3 S 1",
				"? S * S ?",
				"? 1 1 1 ?"
			],
			why: "The 3 sees three flags. Clicking it opens the other four cells at once."
		},
		puzzles: [
			{
				title: "Chord all three",
				chordOnly: true,
				grid: [
					". * . . * . . * .",
					". 1 . * 2 . * 3 *",
					". . . . . . . . ."
				],
				solution: [
					"S * S S * S S * S",
					"S 1 S * 2 S * 3 *",
					"S S S S S S S S S"
				]
			}
		]
	}
	]
},
{
	id: "simple",
	title: "Simple moves",
	sub: "Forced mines and satisfied clears.",
	lessons: [
	{
		title: "Forced mines",
		idea: "When a clue's number matches its covered neighbours, every one of them is a mine.",
		how: "Find a clue. Count its covered neighbours. If they match the number, flag them all.",
		demo: {
			title: "Worked example",
			grid: [
				"? ? ? ? ? ? ? ?",
				"? ? ? ? 1 1 1 ?",
				"? ? ? ? 1 . 1 ?",
				"? ? ? ? 1 1 1 ?",
				"? ? ? ? ? ? ? ?"
			],
			solution: [
				"? ? ? ? ? ? ? ?",
				"? ? ? ? 1 1 1 ?",
				"? ? ? ? 1 M 1 ?",
				"? ? ? ? 1 1 1 ?",
				"? ? ? ? ? ? ? ?"
			],
			why: "Every 1 around the covered cell needs one mine, and the cell is its only candidate — it must be the mine."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					". . . . . . .",
					". m . . . m .",
					". . . . . . .",
					". . . . . . .",
					". . . . . . .",
					". . m . m . .",
					". . . . . . ."
				],
				solution: [
					". . . . . . .",
					". m . . . m .",
					". . . . . . .",
					". . . . . . .",
					". . . . . . .",
					". . m . m . .",
					". . . . . . ."
				]
			}
		]
	},
	{
		title: "Satisfied clear",
		idea: "When a clue's flags equal its number, the rest of its neighbours are safe.",
		how: "Find a clue whose flags match its value. Open every other cell it touches.",
		demo: {
			title: "Worked example",
			grid: [
				"1 1 2 1 1",
				"1 * 2 * 1",
				". . . . ."
			],
			solution: [
				"1 1 2 1 1",
				"1 * 2 * 1",
				"S S S S S"
			],
			why: "Both flags satisfy the 2. Its other neighbours must be safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					". . . . .",
					". m . m .",
					". . . . ."
				],
				solution: [
					". . . . .",
					". m . m .",
					". . . . ."
				]
			}
		]
	}
	]
},
{
	id: "intermediate",
	title: "Intermediate moves",
	sub: "Subset rules, named patterns, and case analysis.",
	lessons: [
	{
		title: "Subset rule — safe cells",
		idea: "When two clues need the same mines and one's candidates are inside the other's, the extras are safe.",
		how: "Find clues A ⊆ B with equal numbers. B's extra cells must be safe.",
		demo: {
			title: "Worked example",
			grid: [
				". . .",
				"1 1 .",
				"? ? ?"
			],
			solution: [
				". . S",
				"1 1 .",
				"? ? ?"
			],
			why: "Both 1s need one mine. The left 1's candidates sit inside the right 1's — the extra right cell is safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					"m . . m . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				],
				solution: [
					"m . . m . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				]
			}
		]
	},
	{
		title: "Subset rule — mines",
		idea: "When B needs exactly as many more mines as it has extra cells, those extras are all mines.",
		how: "Find A ⊆ B where B's number is bigger by exactly the extra cell count. Flag the extras.",
		demo: {
			title: "Worked example",
			grid: [
				". . .",
				"1 2 .",
				"? ? ?"
			],
			solution: [
				". . M",
				"1 2 .",
				"? ? ?"
			],
			why: "The 2 needs one more mine than the 1, and it has exactly one extra cell. That cell must be the mine."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					"m . m . . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				],
				solution: [
					"m . m . . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				]
			}
		]
	},
	{
		title: "Named patterns",
		idea: "Two shapes repeat all the time: 1-2-1 and 1-2-2-1 along a covered wall.",
		how: "1-2-1 → mines on the ends. 1-2-2-1 → mines in the middle two.",
		demo: {
			title: "1-2-1: mines on the ends",
			grid: [
				". . .",
				"1 2 1",
				". . ."
			],
			solution: [
				"M S M",
				"1 2 1",
				". . ."
			],
			why: "The centre 2 forces both ends to be mines. The cell between them is safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					". m m . . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				],
				solution: [
					". m m . . .",
					". . . . . .",
					". . . . . .",
					". . . . . ."
				]
			}
		]
	},
	{
		title: "Chains",
		idea: "Solve one cell at a time. Each new clue helps you read the next.",
		how: "Start with the most constrained clue. Solve it, then re-read its neighbours.",
		demo: {
			title: "1-1-2-1 cascade",
			grid: [
				". . . . .",
				"1 1 2 1 1",
				". . . . ."
			],
			solution: [
				"S M S M S",
				"1 1 2 1 1",
				". . . . ."
			],
			why: "Subset on the left 1-1 frees the third cell. The 2 then forces both adjacent cells as mines. Satisfied clear opens the rest."
		},
		puzzles: [
			{
				title: "Solve the board",
				simpleBoard: true,
				grid: [
					". m . m . m . m",
					". . . . . . . .",
					". . . . . . . .",
					". . . . . . . ."
				],
				solution: [
					". m . m . m . m",
					". . . . . . . .",
					". . . . . . . .",
					". . . . . . . ."
				]
			}
		]
	},
	{
		title: "Enumeration",
		idea: "Assume a cell is a mine. Follow the clues. If something breaks, the cell is actually safe.",
		how: "Pick a pivotal cell. Try mine, propagate. Try safe, propagate. One option contradicts — the other is forced.",
		puzzles: [
			{ title: "Find the forced cells", grid: [". . . .", "? 1 2 ?", "? ? ? ?"], solution: ["S . . M", "? 1 2 ?", "? ? ? ?"],
			  why: "If the right cell were safe the 2 would need both shared cells, but then the 1 sees two mines — impossible. So it's a mine; symmetrically the left cell is safe." },
			{ title: "The mirror image", grid: [". . . .", "? 2 1 ?", "? ? ? ?"], solution: ["M . . S", "? 2 1 ?", "? ? ? ?"],
			  why: "Same reasoning flipped: the left cell is forced to a mine and the right cell to safe." }
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
			{ title: "Two cells vs three", grid: [". . . . .", "1 ? ? 1 ?", "? ? ? ? ?"], solution: ["B B G G G", "1 ? ? 1 ?", "? ? ? ? ?"],
			  why: "Left 1 over two cells → 1/2 each. Right 1 over three cells → 1/3 each. Guess in the right group." },
			{ title: "Watch the number", grid: [". . . . .", "1 ? ? 2 ?", "? ? ? ? ?"], solution: ["G G B B B", "1 ? ? 2 ?", "? ? ? ? ?"],
			  why: "Left 1 over two cells → 1/2 each. Right 2 over three cells → 2/3 each. This time the left group is safer." }
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
			var locked = idx > 0 && !courseIsComplete(LEARN_COURSES[idx - 1].id);
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
	container.innerHTML = "";
	var lesson = lessons[learnState.currentLesson];
	container.appendChild(buildLearnLesson(lesson, learnState.currentLesson, lessons.length, function() {
		if (!completed[learnState.currentLesson]) {
			completed[learnState.currentLesson] = true;
			if (courseIsComplete(course.id) && !learnState.completedAt[course.id]) {
				learnState.completedAt[course.id] = Date.now();
			}
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

// Render a demo grid to a canvas. Demos are static — the grid token IS the
// display: `0-8` = revealed clue with that value, `?` = revealed empty,
// `.` = covered, `*` = flagged, `b` = revealed mine, `m` = covered mine
// shown via x-ray. A solution `M` on a `.` cell also promotes it to an
// x-ray mine (existing demos use that convention). S/G/B are no longer
// drawn — demos don't decorate cells with checkmarks anymore.
var LEARN_CELL_PX = 32;
function renderDemoBoard(grid, solution) {
	var rows = grid.map(function(r) { return r.trim().split(/\s+/); });
	var sol = (solution || grid).map(function(r) { return r.trim().split(/\s+/); });
	var R = rows.length, C = rows[0].length;
	var COVERED = 0, REVEALED = 1, FLAGGED_S = 2;
	var state = [], isMineArr = [], clueArr = [];
	for (var r = 0; r < R; r++) {
		state[r] = []; isMineArr[r] = []; clueArr[r] = [];
		for (var c = 0; c < C; c++) {
			var t = rows[r][c];
			var st = sol[r] && sol[r][c];
			if (/^[1-8]$/.test(t)) { state[r][c] = REVEALED; isMineArr[r][c] = false; clueArr[r][c] = parseInt(t, 10); }
			else if (t === "?") { state[r][c] = REVEALED; isMineArr[r][c] = false; clueArr[r][c] = 0; }
			else if (t === "*") { state[r][c] = FLAGGED_S; isMineArr[r][c] = true; clueArr[r][c] = 0; }
			else if (t === "b") { state[r][c] = REVEALED; isMineArr[r][c] = true; clueArr[r][c] = 0; }
			else if (t === "m") { state[r][c] = COVERED; isMineArr[r][c] = true; clueArr[r][c] = 0; }
			else if (st === "M" || st === "B") { state[r][c] = COVERED; isMineArr[r][c] = true; clueArr[r][c] = 0; }
			else { state[r][c] = COVERED; isMineArr[r][c] = false; clueArr[r][c] = 0; }
		}
	}
	var view = {
		rows: R, cols: C,
		isCovered: function(r, c) { return state[r][c] === COVERED; },
		isRevealed: function(r, c) { return state[r][c] === REVEALED; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED_S; },
		isMine: function(r, c) { return isMineArr[r][c]; },
		getClue: function(r, c) { return clueArr[r][c]; },
		xray: true
	};
	var wrap = document.createElement("div");
	wrap.className = "learn-board";
	var canvas = document.createElement("canvas");
	canvas.width = Math.round(C * LEARN_CELL_PX * DPR);
	canvas.height = Math.round(R * LEARN_CELL_PX * DPR);
	canvas.style.width = (C * LEARN_CELL_PX) + "px";
	canvas.style.height = (R * LEARN_CELL_PX) + "px";
	var ctx = canvas.getContext("2d");
	var sw = canvas.width / C, sh = canvas.height / R;
	for (var r2 = 0; r2 < R; r2++) for (var c2 = 0; c2 < C; c2++) drawCell(ctx, r2, c2, view, sw, sh, null);
	wrap.appendChild(canvas);
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
		for (var t = 0; t < demo.tiles.length; t++) {
			var tile = demo.tiles[t];
			tilesWrap.appendChild(renderDemoBoard(tile.grid, tile.solution || tile.grid));
		}
		wrap.appendChild(tilesWrap);
	} else if (demo.grid) {
		wrap.appendChild(renderDemoBoard(demo.grid, demo.solution || demo.grid));
	}

	if (demo.why) {
		var why = document.createElement("div");
		why.className = "learn-demo-why";
		why.textContent = demo.why;
		wrap.appendChild(why);
	}

	return wrap;
}

// Real-game-like puzzle board. Each cell behaves as it would in a live game:
//   left-click  COVERED  → reveal (cascade on 0, boom on mine)
//   left-click  REVEALED → chord (if flag count == clue value)
//   right-click COVERED/FLAGGED → toggle flag
//   right-click REVEALED → also chord
// The puzzle's "objective" is derived from the solution tokens:
//   M  → that cell must end up FLAGGED
//   S  → that cell must end up REVEALED (via direct click, cascade, or chord)
//   G  → guess-mode: revealing any G cell solves the puzzle
//   B  → guess-mode mine (revealing it explodes)
function buildLearnPuzzle(puzzle, isGuess, onSolved) {
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

	var rows = puzzle.grid.map(function(r) { return r.trim().split(/\s+/); });
	var sol = puzzle.solution.map(function(r) { return r.trim().split(/\s+/); });
	var R = rows.length, C = rows[0].length;
	var COVERED = 0, REVEALED = 1, FLAGGED = 2;

	// Underlying truth: which cells are mines. Grid tokens that mean "mine":
	//   *  pre-flagged mine (student sees it as flagged from the start)
	//   b  pre-revealed bomb (used in demos only)
	//   m  covered mine with no objective attached (student can't tell it apart
	//      from a `.` candidate just by looking — they have to read the clues)
	// Solution tokens M / B also mark a cell as mine for the puzzle logic.
	var isMine = [];
	for (var r = 0; r < R; r++) {
		isMine[r] = [];
		for (var c = 0; c < C; c++) {
			var t = rows[r][c], st = sol[r][c];
			isMine[r][c] = (t === "*" || t === "b" || t === "m" || st === "M" || st === "B");
		}
	}

	function neighbours(r, c) { return BoardLogic.neighbours(r, c, R, C); }

	var clueValue = BoardLogic.buildClueGrid(R, C, function(r, c) { return isMine[r][c]; });

	function initialStateFor(t) {
		if (t === "." || t === "m") return COVERED;
		if (t === "*") return FLAGGED;
		return REVEALED; // 0-8, ?, b
	}

	var state = [];
	for (var r = 0; r < R; r++) {
		state[r] = [];
		for (var c = 0; c < C; c++) state[r][c] = initialStateFor(rows[r][c]);
	}

	// simpleBoard mode: treat the grid as just mines (`m`) and safe cells (`.`),
	// then run a cascade from the bottom-left corner. The student plays the
	// resulting position like a normal minesweeper game.
	function initialCascade(r, c) {
		BoardLogic.cascadeReveal(r, c, R, C,
			function(rr, cc) { return state[rr][cc] === COVERED && !isMine[rr][cc]; },
			function(rr, cc) { state[rr][cc] = REVEALED; return false; },
			function(rr, cc) { return clueValue[rr][cc]; }
		);
	}
	if (puzzle.simpleBoard) initialCascade(R - 1, 0);

	var view = {
		rows: R, cols: C,
		isCovered: function(r, c) { return state[r][c] === COVERED; },
		isRevealed: function(r, c) { return state[r][c] === REVEALED; },
		isFlagged: function(r, c) { return state[r][c] === FLAGGED; },
		isMine: function(r, c) { return isMine[r][c]; },
		getClue: function(r, c) { return clueValue[r][c]; },
		xray: false
	};

	var boardWrap = document.createElement("div");
	boardWrap.className = "learn-board";
	var canvas = document.createElement("canvas");
	canvas.width = Math.round(C * LEARN_CELL_PX * DPR);
	canvas.height = Math.round(R * LEARN_CELL_PX * DPR);
	canvas.style.width = (C * LEARN_CELL_PX) + "px";
	canvas.style.height = (R * LEARN_CELL_PX) + "px";
	canvas.style.cursor = "pointer";
	boardWrap.appendChild(canvas);
	wrap.appendChild(boardWrap);
	var ctx = canvas.getContext("2d");

	function renderAll() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		var sw = canvas.width / C, sh = canvas.height / R;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) drawCell(ctx, r, c, view, sw, sh, null);
	}
	renderAll();

	var status = document.createElement("span");
	status.className = "learn-status";

	var puzzleSolved = false, gameOver = false;

	function setStatus(text, cls) {
		status.textContent = text;
		status.className = "learn-status" + (cls ? " " + cls : "");
	}

	function notifySolved() {
		if (puzzleSolved) return;
		puzzleSolved = true;
		solvedTick.textContent = "✓";
		if (typeof onSolved === "function") onSolved();
	}

	function progressStatus() {
		if (isGuess) { setStatus("", ""); return; }
		if (puzzle.simpleBoard) {
			var total = 0, opened = 0;
			for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
				if (!isMine[r][c]) {
					total++;
					if (state[r][c] === REVEALED) opened++;
				}
			}
			setStatus(opened + " / " + total + " safe cells opened", "");
			return;
		}
		var flaggedTarget = 0, flaggedHave = 0, revealTarget = 0, revealHave = 0;
		for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
			if (sol[r][c] === "M") {
				flaggedTarget++;
				if (state[r][c] === FLAGGED) flaggedHave++;
			}
			if (sol[r][c] === "S") {
				revealTarget++;
				if (state[r][c] === REVEALED && !isMine[r][c]) revealHave++;
			}
		}
		var parts = [];
		if (flaggedTarget) parts.push(flaggedHave + " / " + flaggedTarget + " flagged");
		if (revealTarget) parts.push(revealHave + " / " + revealTarget + " opened");
		setStatus(parts.join(", "), "");
	}

	function checkSolved() {
		if (puzzleSolved || gameOver) return;
		if (isGuess) {
			for (var r = 0; r < R; r++) for (var c = 0; c < C; c++) {
				if (sol[r][c] === "G" && state[r][c] === REVEALED) {
					setStatus("Good guess — lowest risk on the board.", "ok");
					notifySolved();
					return;
				}
			}
			return;
		}
		var allOk = true;
		if (puzzle.simpleBoard) {
			for (var r = 0; r < R && allOk; r++) for (var c = 0; c < C && allOk; c++) {
				if (!isMine[r][c] && state[r][c] !== REVEALED) allOk = false;
			}
		} else {
			for (var r = 0; r < R && allOk; r++) for (var c = 0; c < C && allOk; c++) {
				if (sol[r][c] === "M" && state[r][c] !== FLAGGED) allOk = false;
				if (sol[r][c] === "S" && state[r][c] !== REVEALED) allOk = false;
			}
		}
		if (allOk) {
			setStatus("Solved! ✓", "ok");
			notifySolved();
		} else {
			progressStatus();
		}
	}

	function revealCell(r, c) {
		BoardLogic.cascadeReveal(r, c, R, C,
			function(rr, cc) { return state[rr][cc] === COVERED; },
			function(rr, cc) {
				state[rr][cc] = REVEALED;
				if (isMine[rr][cc]) {
					gameOver = true;
					setStatus(isGuess ? "Bad guess — the other group has better odds. Reset to try again." : "You hit a mine. Reset to try again.", "warn");
					return true;
				}
				return false;
			},
			function(rr, cc) { return clueValue[rr][cc]; }
		);
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
		for (var i = 0; i < cctx.covered.length; i++) revealCell(cctx.covered[i][0], cctx.covered[i][1]);
	}

	function toggleFlag(r, c) {
		if (state[r][c] === COVERED) state[r][c] = FLAGGED;
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
		for (var r = 0; r < R; r++) {
			for (var c = 0; c < C; c++) state[r][c] = initialStateFor(rows[r][c]);
		}
		if (puzzle.simpleBoard) initialCascade(R - 1, 0);
		gameOver = false;
		puzzleSolved = false;
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
	return wrap;
}
