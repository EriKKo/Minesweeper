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
		board: {
			rows: 7,
			cols: 13,
			mines: [[2,2], [2,6], [2,10], [2,11], [5,2], [5,4]],
			revealAll: true,
			covered: [[5,3]]
		},
		intro: [
			"Every number counts the mines in the 8 cells touching it.",
			"Only one covered cell on this board is safe. Left-click it to open it."
		],
		hints: [
			"Look at the two 2s directly above and below the covered cell.",
			"Each of those 2s already touches the mines to its left and right — that's 2 mines accounted for, before you even count the cell between them.",
			"Neither 2 needs the covered cell — both are already satisfied by a mine elsewhere. That makes it safe. Click it."
		],
		mistakes: {
			mine: "That was one of the mines. Reset and look at the numbers around the covered cell again."
		},
		outro: "That's reading the board: every number is a promise about exactly what's around it."
	},
	{
		title: "Flagging mines",
		board: {
			rows: 5,
			cols: 9,
			mines: [[2,2], [2,6], [2,7]],
			revealAll: true,
			mustFlag: true
		},
		intro: [
			"Right-click a covered cell to flag it — a mark for a mine you've found, so you don't open it by accident.",
			"Flag every mine on this board."
		],
		hints: [
			"Every revealed number points at exactly one covered neighbour — that neighbour is the mine it's counting.",
			"Right-click each covered cell in turn. If you flag the wrong one by mistake, right-click it again to clear it."
		],
		mistakes: {
			wrongFlag: "That covered cell isn't actually a mine — check which cell each number next to it is really pointing at."
		},
		outro: "All flagged. Now none of these can catch you by accident."
	},
	{
		title: "Chord click",
		board: {
			rows: 3,
			cols: 9,
			mines: [[0,1], [0,4], [0,7], [1,3], [1,6], [1,8]],
			flagged: [[0,1], [0,4], [0,7], [1,3], [1,6], [1,8]],
			revealed: [[1,1], [1,4], [1,7]],
			chordOnly: true
		},
		intro: [
			"When a number's flags already match its value, click the NUMBER itself to open all its other neighbours in one move — a chord.",
			"All three numbers here are already satisfied by their flags. Chord each one."
		],
		hints: [
			"Click directly on a revealed number, not on a covered cell.",
			"Left- or right-click both chord — either works the same way.",
			"Click each of the three revealed numbers in the middle row."
		],
		outro: "Three chords, board cleared — the fastest way to open cells you've already worked out."
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
			rows: 5,
			cols: 8,
			mines: [[2,5]],
			revealStart: [4,0],
			xray: true,
			why: "Every 1 around the covered cell needs one mine, and the cell is its only candidate — it must be the mine."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 7,
				cols: 7,
				mines: [[1,1], [1,5], [5,2], [5,4]],
				revealStart: [6,0]
			}
		]
	},
	{
		title: "Satisfied clear",
		idea: "When a clue's flags equal its number, the rest of its neighbours are safe.",
		how: "Find a clue whose flags match its value. Open every other cell it touches.",
		demo: {
			title: "Worked example",
			rows: 3,
			cols: 5,
			mines: [[1,1], [1,3]],
			flagged: [[1,1], [1,3]],
			revealAll: true,
			covered: [[2,0], [2,1], [2,2], [2,3], [2,4]],
			xray: true,
			why: "Both flags satisfy the 2. Its other neighbours must be safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 3,
				cols: 5,
				mines: [[1,1], [1,3]],
				revealStart: [2,0]
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
			rows: 3,
			cols: 3,
			revealAll: true,
			covered: [[0,0], [0,1], [0,2], [1,2]],
			xray: true,
			why: "Both 1s need one mine. The left 1's candidates sit inside the right 1's — the extra right cell is safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 4,
				cols: 6,
				mines: [[0,0], [0,3]],
				revealStart: [3,0]
			}
		]
	},
	{
		title: "Subset rule — mines",
		idea: "When B needs exactly as many more mines as it has extra cells, those extras are all mines.",
		how: "Find A ⊆ B where B's number is bigger by exactly the extra cell count. Flag the extras.",
		demo: {
			title: "Worked example",
			rows: 3,
			cols: 3,
			mines: [[0,2]],
			revealAll: true,
			covered: [[0,0], [0,1], [1,2]],
			xray: true,
			why: "The 2 needs one more mine than the 1, and it has exactly one extra cell. That cell must be the mine."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 4,
				cols: 6,
				mines: [[0,0], [0,2]],
				revealStart: [3,0]
			}
		]
	},
	{
		title: "Named patterns",
		idea: "Two shapes repeat all the time: 1-2-1 and 1-2-2-1 along a covered wall.",
		how: "1-2-1 → mines on the ends. 1-2-2-1 → mines in the middle two.",
		demo: {
			title: "1-2-1: mines on the ends",
			rows: 3,
			cols: 3,
			mines: [[0,0], [0,2]],
			revealed: [[1,0], [1,1], [1,2]],
			xray: true,
			why: "The centre 2 forces both ends to be mines. The cell between them is safe."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 4,
				cols: 6,
				mines: [[0,1], [0,2]],
				revealStart: [3,0]
			}
		]
	},
	{
		title: "Chains",
		idea: "Solve one cell at a time. Each new clue helps you read the next.",
		how: "Start with the most constrained clue. Solve it, then re-read its neighbours.",
		demo: {
			title: "1-1-2-1 cascade",
			rows: 3,
			cols: 5,
			mines: [[0,1], [0,3]],
			revealed: [[1,0], [1,1], [1,2], [1,3], [1,4]],
			xray: true,
			why: "Subset on the left 1-1 frees the third cell. The 2 then forces both adjacent cells as mines. Satisfied clear opens the rest."
		},
		puzzles: [
			{
				title: "Solve the board",
				rows: 4,
				cols: 8,
				mines: [[0,1], [0,3], [0,5], [0,7]],
				revealStart: [3,0]
			}
		]
	},
	{
		title: "Enumeration",
		idea: "Assume a cell is a mine. Follow the clues. If something breaks, the cell is actually safe.",
		how: "Pick a pivotal cell. Try mine, propagate. Try safe, propagate. One option contradicts — the other is forced.",
		puzzles: [
			{
				title: "Find the forced cells",
				rows: 3,
				cols: 4,
				mines: [[0,3]],
				revealAll: true,
				covered: [[0,0], [0,1], [0,2]],
				mustFlag: true,
				why: "If the right cell were safe the 2 would need both shared cells, but then the 1 sees two mines — impossible. So it's a mine; symmetrically the left cell is safe."
			},
			{
				title: "The mirror image",
				rows: 3,
				cols: 4,
				mines: [[0,0]],
				revealAll: true,
				covered: [[0,1], [0,2], [0,3]],
				mustFlag: true,
				why: "Same reasoning flipped: the left cell is forced to a mine and the right cell to safe."
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
	// Dispatches on lesson shape: `board` means the new mentor-guided format (a single interactive
	// board coached by an instructor panel — see buildMentorLesson); `puzzles` means the older
	// prose-plus-practice-puzzles format (buildLearnLesson) that courses not yet ported still use.
	// Both take the same (lesson, idx, total, onLessonComplete) signature.
	container.innerHTML = "";
	var lesson = lessons[learnState.currentLesson];
	var buildLesson = lesson.board ? buildMentorLesson : buildLearnLesson;
	container.appendChild(buildLesson(lesson, learnState.currentLesson, lessons.length, function() {
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

// Mentor-guided lesson: one interactive board (built with the exact same buildLearnPuzzle every
// other real board on the site uses — chord/cascade/flag all behave identically, nothing here
// reimplements them) coached from a text feed instead of surrounded by prose and static demo
// boards. A lesson object looks like:
//   board: {...}             — a normal buildLearnPuzzle board spec (rows/cols/mines/revealStart/
//                               mustFlag/chordOnly/guess/goodGuessCells/...)
//   requirements: {...}      — optional extra win condition beyond the board's base objective, see
//                               buildLearnPuzzle's own comment (minCascades/minChords)
//   intro: "..." | ["...", ...]  — opening message(s), shown immediately
//   hints: ["...", ...]      — revealed one at a time by the Hint button, most specific last
//   mistakes: { mine: "...", wrongFlag: "..." }  — shown when that mistake happens (see onMistake)
//   outro: "..."             — shown once solved
function buildMentorLesson(lesson, idx, total, onLessonComplete) {
	var card = document.createElement("div");
	card.className = "section-card learn-mentor";

	var layout = document.createElement("div");
	layout.className = "learn-mentor-layout";
	card.appendChild(layout);

	var boardCol = document.createElement("div");
	boardCol.className = "learn-mentor-board-col";
	layout.appendChild(boardCol);

	var panel = document.createElement("div");
	panel.className = "learn-mentor-panel";
	layout.appendChild(panel);

	var title = document.createElement("h2");
	title.className = "learn-mentor-title";
	title.textContent = lesson.title;
	panel.appendChild(title);

	var feed = document.createElement("div");
	feed.className = "learn-mentor-feed";
	panel.appendChild(feed);

	// Appends one message bubble and scrolls it into view — the feed reads top-to-bottom like a
	// running conversation, oldest first, so a player can scroll back up to see what they missed.
	function say(text, kind) {
		if (!text) return;
		var msg = document.createElement("div");
		msg.className = "learn-mentor-msg" + (kind ? " learn-mentor-msg-" + kind : "");
		msg.textContent = text;
		feed.appendChild(msg);
		feed.scrollTop = feed.scrollHeight;
	}

	var introLines = Array.isArray(lesson.intro) ? lesson.intro : (lesson.intro ? [lesson.intro] : []);
	introLines.forEach(function(line) { say(line, "intro"); });

	// Hints are opt-in and progressive: each click reveals the next, most specific last. Never
	// triggered automatically — the player asks for help rather than being interrupted by it.
	var hints = lesson.hints || [];
	var hintIdx = 0;
	var hintBtn = null;
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
		panel.appendChild(hintBtn);
	}

	var solved = false;
	function onSolved() {
		if (solved) return;
		solved = true;
		say(lesson.outro, "outro");
		if (hintBtn) hintBtn.disabled = true;
		if (typeof onLessonComplete === "function") onLessonComplete();
	}

	function onMistake(kind, info) {
		say(lesson.mistakes && lesson.mistakes[kind], "mistake");
	}

	var puzzle = Object.assign({ title: lesson.title }, lesson.board, { requirements: lesson.requirements });
	boardCol.appendChild(buildLearnPuzzle(puzzle, !!lesson.guess, onSolved, null, onMistake));

	return card;
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
// Objective is "open all safe cells" by default; mustFlag/guess change it.
// Optional puzzle.requirements ({ minCascades, minChords }) adds an extra condition on top of that
// base objective — e.g. the board must be cleared using at least one real cascade, not just clicked
// open cell by cell. Optional onMistake(kind, info) — "mine" | "wrongFlag" — is called alongside
// onFailed (mine hit only) so a caller can react to specific error types, not just "you lost";
// existing callers that don't pass it are unaffected.
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
					gameOver = true;
					hitMine = true;
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
