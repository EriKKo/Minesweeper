// Admin "Board animations" lab (/admin/countdown) — a living, tabbed preview of three separate
// board animation systems, each looping on its own small board so they can be reviewed without
// starting a real match: the round-start countdown digit (COUNTDOWN_STYLE), the one-shot "go" sweep
// that follows it (BOARD_GO_STYLE), and the continuous idle animation shown while waiting for a
// casual series to start (BOARD_IDLE_STYLE) — all in Animations.js. The controls edit those same
// style objects a real round reads, so tuning here tunes the actual game, not a copy of it.

var COUNTDOWN_LAB_ROWS = 16, COUNTDOWN_LAB_COLS = 20; // ranked's actual medium board
var COUNTDOWN_LAB_TABS = [
	{ id: "digit", label: "Countdown digit" },
	{ id: "go", label: "Go sweep" },
	{ id: "idle", label: "Idle" }
];
var countdownLabTab = "digit"; // remembered across re-renders within a session, like profileTab

var countdownLabGlyphs = []; // oldest first — a negative gapMs can leave more than one alive at once
var countdownLabCells = {}; // "r,c" -> {number,litSince,fadeOutStart} — used when persistUnchanged is on
var countdownLabGoAnim = null; // { start } | null — the lab's own "go" sweep, independent of boardGoAnim
var countdownLabSeqTimer = null;
var countdownLabRAF = null;

function renderCountdownLab() {
	var view = document.getElementById("countdown_lab_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Board animations";
	view.appendChild(title);
	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Live preview of three separate board animations on their own board (16×20, ranked's medium size) — pick a tab to focus on. The controls edit the real style objects a match reads, so this is the exact code, not a copy of it.";
	view.appendChild(sub);

	var tabsBar = document.createElement("div");
	tabsBar.className = "lb-tabs countdown-lab-tabs";
	COUNTDOWN_LAB_TABS.forEach(function(t) {
		var b = document.createElement("button");
		b.type = "button";
		b.className = "lb-tab";
		b.textContent = t.label;
		b.dataset.tab = t.id;
		b.addEventListener("click", function() { selectCountdownLabTab(t.id); });
		tabsBar.appendChild(b);
	});
	view.appendChild(tabsBar);

	var layout = document.createElement("div");
	layout.className = "countdown-lab-layout";

	var canvasCard = document.createElement("div");
	canvasCard.className = "section-card countdown-lab-canvas-card";
	var canvas = document.createElement("canvas");
	canvas.id = "countdown_lab_canvas";
	canvas.width = 600;
	canvas.height = 480;
	canvas.className = "countdown-lab-canvas";
	canvasCard.appendChild(canvas);
	layout.appendChild(canvasCard);

	var controls = document.createElement("div");
	controls.className = "section-card countdown-lab-controls";

	// target is the live style object (COUNTDOWN_STYLE / BOARD_GO_STYLE / BOARD_IDLE_STYLE) the row
	// edits directly. parent defaults to `controls` but panels pass themselves so rows land inside
	// the right tab's panel instead of always at the controls card's top level.
	function addSlider(parent, target, label, key, min, max, step, format) {
		var row = document.createElement("div");
		row.className = "setting-row countdown-lab-row";
		var text = document.createElement("div");
		text.className = "setting-row-text";
		var lbl = document.createElement("span");
		lbl.className = "setting-row-label";
		lbl.textContent = label;
		text.appendChild(lbl);
		row.appendChild(text);

		var val = document.createElement("span");
		val.className = "countdown-lab-val";
		val.textContent = format(target[key]);
		row.appendChild(val);

		var slider = document.createElement("input");
		slider.type = "range";
		slider.className = "cr-slider countdown-lab-slider";
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(target[key]);
		slider.setAttribute("aria-label", label);
		slider.addEventListener("input", function() {
			target[key] = parseFloat(slider.value);
			val.textContent = format(target[key]);
		});
		row.appendChild(slider);
		parent.appendChild(row);
	}

	function addColorPicker(parent, target, label) {
		var colorRow = document.createElement("div");
		colorRow.className = "setting-row countdown-lab-row countdown-lab-color-row";
		var colorText = document.createElement("div");
		colorText.className = "setting-row-text";
		var colorLbl = document.createElement("span");
		colorLbl.className = "setting-row-label";
		colorLbl.textContent = label;
		colorText.appendChild(colorLbl);
		colorRow.appendChild(colorText);
		var colorVal = document.createElement("span");
		colorVal.className = "countdown-lab-val";
		colorVal.textContent = target.color;
		colorRow.appendChild(colorVal);
		var colorInput = document.createElement("input");
		colorInput.type = "color";
		colorInput.className = "countdown-lab-color";
		colorInput.value = target.color;
		colorInput.setAttribute("aria-label", label);
		colorInput.addEventListener("input", function() {
			target.color = colorInput.value;
			colorVal.textContent = colorInput.value;
		});
		colorRow.appendChild(colorInput);
		parent.appendChild(colorRow);
	}

	function addSeg(parent, target, label, options, onChange) {
		var seg = document.createElement("div");
		seg.className = "cr-seg";
		options.forEach(function(opt) {
			var btn = document.createElement("button");
			btn.type = "button";
			btn.textContent = opt.label;
			btn.classList.toggle("active", target.mode === opt.id);
			btn.addEventListener("click", function() {
				target.mode = opt.id;
				seg.querySelectorAll("button").forEach(function(b) { b.classList.remove("active"); });
				btn.classList.add("active");
				if (onChange) onChange();
			});
			seg.appendChild(btn);
		});
		parent.appendChild(seg);
	}

	// ---- Countdown digit panel ----
	var digitPanel = document.createElement("div");
	digitPanel.id = "countdown_lab_panel_digit";

	var modeHead = document.createElement("h2");
	modeHead.className = "controls-title";
	modeHead.textContent = "Style";
	digitPanel.appendChild(modeHead);
	addSeg(digitPanel, COUNTDOWN_STYLE, "Style", [
		{ id: "glow", label: "Glow" },
		{ id: "pressed", label: "Pressed in" },
		{ id: "flat", label: "Flat colour" },
		{ id: "reveal", label: "Reveal numbers" }
	]);
	addColorPicker(digitPanel, COUNTDOWN_STYLE, "Base colour");

	var persistRow = document.createElement("label");
	persistRow.className = "setting-row countdown-lab-checkbox-row";
	var persistText = document.createElement("div");
	persistText.className = "setting-row-text";
	var persistLbl = document.createElement("span");
	persistLbl.className = "setting-row-label";
	persistLbl.textContent = "Keep unchanged cells";
	var persistNote = document.createElement("span");
	persistNote.className = "setting-row-note";
	persistNote.textContent = "A cell lit by two digits in a row (e.g. 3 and 2 share their top row) stays put instead of fading out and back in. Hold no longer applies per-cell — a shared cell just holds until a digit drops it.";
	persistText.appendChild(persistLbl);
	persistText.appendChild(persistNote);
	persistRow.appendChild(persistText);
	var persistCheckbox = document.createElement("input");
	persistCheckbox.type = "checkbox";
	persistCheckbox.className = "countdown-lab-checkbox";
	persistCheckbox.checked = COUNTDOWN_STYLE.persistUnchanged;
	persistCheckbox.addEventListener("change", function() {
		COUNTDOWN_STYLE.persistUnchanged = persistCheckbox.checked;
		countdownLabStart(); // switches which state (glyph list vs cell map) is live — start clean
	});
	persistRow.appendChild(persistCheckbox);
	digitPanel.appendChild(persistRow);

	var tuneHead = document.createElement("h2");
	tuneHead.className = "controls-title countdown-lab-tune-title";
	tuneHead.textContent = "Tuning";
	digitPanel.appendChild(tuneHead);
	addSlider(digitPanel, COUNTDOWN_STYLE, "Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider(digitPanel, COUNTDOWN_STYLE, "Depth (indent / bloom)", "indent", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider(digitPanel, COUNTDOWN_STYLE, "Fade-in", "fadeInMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(digitPanel, COUNTDOWN_STYLE, "Hold", "holdMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(digitPanel, COUNTDOWN_STYLE, "Fade-out", "fadeOutMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(digitPanel, COUNTDOWN_STYLE, "Delay between numbers", "gapMs", -900, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	controls.appendChild(digitPanel);

	// ---- Go sweep panel ----
	var goPanel = document.createElement("div");
	goPanel.id = "countdown_lab_panel_go";

	var goHead = document.createElement("h2");
	goHead.className = "controls-title";
	goHead.textContent = "Style";
	goPanel.appendChild(goHead);
	var goSub = document.createElement("p");
	goSub.className = "countdown-lab-go-sub";
	goSub.textContent = "Plays once, the instant the countdown finishes — purely decorative, doesn't affect when input actually unlocks.";
	goPanel.appendChild(goSub);
	addSeg(goPanel, BOARD_GO_STYLE, "Style", [
		{ id: "diagonal", label: "Diagonal" },
		{ id: "radial", label: "Radial" },
		{ id: "rowWipe", label: "Row wipe" },
		{ id: "colWipe", label: "Col wipe" }
	]);
	addColorPicker(goPanel, BOARD_GO_STYLE, "Sweep colour");

	var goTuneHead = document.createElement("h2");
	goTuneHead.className = "controls-title countdown-lab-tune-title";
	goTuneHead.textContent = "Tuning";
	goPanel.appendChild(goTuneHead);
	addSlider(goPanel, BOARD_GO_STYLE, "Duration", "durationMs", 150, 2000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(goPanel, BOARD_GO_STYLE, "Width", "width", 0.5, 10, 0.5, function(v) { return v.toFixed(1) + " cells"; });
	addSlider(goPanel, BOARD_GO_STYLE, "Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });

	var playGoBtn = document.createElement("button");
	playGoBtn.type = "button";
	playGoBtn.className = "btn btn-secondary countdown-lab-play-go";
	playGoBtn.textContent = "Play sweep now";
	playGoBtn.addEventListener("click", function() {
		countdownLabGoAnim = buildBoardGoAnimState();
		if (!countdownLabRAF) countdownLabDrawLoop();
	});
	goPanel.appendChild(playGoBtn);
	controls.appendChild(goPanel);

	// ---- Idle panel ----
	var idlePanel = document.createElement("div");
	idlePanel.id = "countdown_lab_panel_idle";

	var idleHead = document.createElement("h2");
	idleHead.className = "controls-title";
	idleHead.textContent = "Style";
	idlePanel.appendChild(idleHead);
	var idleSub = document.createElement("p");
	idleSub.className = "countdown-lab-go-sub";
	idleSub.textContent = "Plays continuously while a casual room is waiting for its series to start — replaces the old static dim + \"Waiting for series to start\" text.";
	idlePanel.appendChild(idleSub);
	addSeg(idlePanel, BOARD_IDLE_STYLE, "Style", [
		{ id: "breathe", label: "Breathe" },
		{ id: "shimmer", label: "Shimmer" },
		{ id: "twinkle", label: "Twinkle" }
	]);
	addColorPicker(idlePanel, BOARD_IDLE_STYLE, "Colour");

	var idleTuneHead = document.createElement("h2");
	idleTuneHead.className = "controls-title countdown-lab-tune-title";
	idleTuneHead.textContent = "Tuning";
	idlePanel.appendChild(idleTuneHead);
	addSlider(idlePanel, BOARD_IDLE_STYLE, "Speed", "speed", 0.2, 3, 0.1, function(v) { return v.toFixed(1) + "×"; });
	addSlider(idlePanel, BOARD_IDLE_STYLE, "Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	controls.appendChild(idlePanel);

	var reset = document.createElement("button");
	reset.type = "button";
	reset.className = "btn btn-secondary keybind-reset";
	reset.textContent = "Reset to defaults";
	reset.addEventListener("click", function() {
		COUNTDOWN_STYLE.mode = "reveal";
		COUNTDOWN_STYLE.fadeInMs = 200;
		COUNTDOWN_STYLE.holdMs = 300;
		COUNTDOWN_STYLE.fadeOutMs = 500;
		COUNTDOWN_STYLE.gapMs = 100;
		COUNTDOWN_STYLE.brightness = 1;
		COUNTDOWN_STYLE.indent = 1;
		COUNTDOWN_STYLE.color = "#bfdbfe";
		COUNTDOWN_STYLE.persistUnchanged = false;
		BOARD_GO_STYLE.mode = "diagonal";
		BOARD_GO_STYLE.durationMs = 700;
		BOARD_GO_STYLE.width = 3;
		BOARD_GO_STYLE.brightness = 0.7;
		BOARD_GO_STYLE.color = "#bfdbfe";
		BOARD_IDLE_STYLE.mode = "twinkle";
		BOARD_IDLE_STYLE.speed = 3;
		BOARD_IDLE_STYLE.brightness = 0.7;
		BOARD_IDLE_STYLE.color = "#bfdbfe";
		renderCountdownLab();
	});
	controls.appendChild(reset);

	layout.appendChild(controls);
	view.appendChild(layout);

	applyCountdownLabTab();
	countdownLabStart();
}

// Show the selected tab's panel, hide the others, mark the matching tab button active — same
// pattern as selectProfileTab in Profile.js.
function applyCountdownLabTab() {
	COUNTDOWN_LAB_TABS.forEach(function(t) {
		var panel = document.getElementById("countdown_lab_panel_" + t.id);
		if (panel) panel.style.display = t.id === countdownLabTab ? "" : "none";
	});
	var bar = document.querySelector(".countdown-lab-tabs");
	if (bar) {
		var btns = bar.querySelectorAll(".lb-tab");
		for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].dataset.tab === countdownLabTab);
	}
}

function selectCountdownLabTab(id) {
	countdownLabTab = id;
	applyCountdownLabTab();
	countdownLabStart(); // switch what the canvas is previewing
}

// Drives whichever animation the active tab is previewing, forever, until teardownCountdownLab
// stops it (see hideAllViews in Router.js).
function countdownLabStart() {
	teardownCountdownLab();
	if (countdownLabTab === "digit") countdownLabStep(3);
	else if (countdownLabTab === "go") countdownLabGoLoop();
	else if (countdownLabTab === "idle" && !countdownLabRAF) countdownLabDrawLoop();
}

// Loops 3 -> 2 -> 1 -> the go sweep -> a short pause -> repeat. Mirrors countDownStep in Overlay.js
// — both read countdownTickMs() (Animations.js) each time, so a slider change mid-loop takes effect
// on the next tick, here and in a real match alike.
function countdownLabStep(number) {
	if (COUNTDOWN_STYLE.persistUnchanged) {
		advanceCountdownCells(countdownLabCells, number, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS);
	} else {
		var g = buildCountdownGlyphState(number, COUNTDOWN_LAB_ROWS);
		if (g) countdownLabGlyphs.push(g);
	}
	// A negative gapMs means this can fire while the PREVIOUS digit's own draw loop is still
	// running (its glyph hasn't finished fading) — only kick a fresh rAF chain if one isn't already
	// live, same guard startAnimLoop uses for the real game, or every digit would start its own
	// concurrent chain that never gets cancelled.
	if (!countdownLabRAF) countdownLabDrawLoop();
	var tickMs = countdownTickMs();
	countdownLabSeqTimer = setTimeout(function() {
		if (number > 1) {
			countdownLabStep(number - 1);
			return;
		}
		// The countdown just finished — play the "go" sweep (same trigger point as
		// countDownStep's number<=0 branch in Overlay.js), then pause a beat before looping back
		// to "3". The pause is at least the sweep's own duration so it isn't cut off mid-play.
		countdownLabGoAnim = buildBoardGoAnimState();
		if (!countdownLabRAF) countdownLabDrawLoop();
		countdownLabSeqTimer = setTimeout(function() { countdownLabStep(3); }, Math.max(700, BOARD_GO_STYLE.durationMs + 300));
	}, tickMs);
}

// Repeats the go sweep on its own (no digits) for the "Go sweep" tab, so tuning it doesn't require
// waiting through a full 3-2-1 cycle each time.
function countdownLabGoLoop() {
	countdownLabGoAnim = buildBoardGoAnimState();
	if (!countdownLabRAF) countdownLabDrawLoop();
	countdownLabSeqTimer = setTimeout(countdownLabGoLoop, Math.max(700, BOARD_GO_STYLE.durationMs + 500));
}

function countdownLabDrawLoop() {
	var canvas = document.getElementById("countdown_lab_canvas");
	if (!canvas) { countdownLabRAF = null; return; }
	var ctx = canvas.getContext("2d");
	var sw = canvas.width / COUNTDOWN_LAB_COLS, sh = canvas.height / COUNTDOWN_LAB_ROWS;
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	var gap = Math.max(1, Math.round(Math.min(sw, sh) * 0.08));
	var w = sw - gap, h = sh - gap;
	var rad = Math.min(w, h) * 0.2;
	for (var r = 0; r < COUNTDOWN_LAB_ROWS; r++) {
		for (var c = 0; c < COUNTDOWN_LAB_COLS; c++) {
			ctx.save();
			ctx.translate(c * sw + gap / 2, r * sh + gap / 2);
			drawUnknown(ctx, w, h, rad);
			ctx.restore();
		}
	}
	var stillGoing = false;
	if (countdownLabTab === "digit") {
		if (COUNTDOWN_STYLE.persistUnchanged) {
			stillGoing = paintCountdownCells(ctx, sw, sh, countdownLabCells, null);
		} else {
			countdownLabGlyphs = paintCountdownGlyphs(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGlyphs, null);
			stillGoing = countdownLabGlyphs.length > 0;
		}
		if (countdownLabGoAnim && !paintBoardGoAnimation(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGoAnim, null)) countdownLabGoAnim = null;
		if (countdownLabGoAnim) stillGoing = true;
	} else if (countdownLabTab === "go") {
		if (countdownLabGoAnim && !paintBoardGoAnimation(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGoAnim, null)) countdownLabGoAnim = null;
		stillGoing = true; // countdownLabGoLoop keeps re-triggering; keep redrawing so new sweeps show
	} else if (countdownLabTab === "idle") {
		paintBoardIdleAnimation(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, null);
		stillGoing = true; // runs forever while this tab is active
	}
	if (stillGoing) countdownLabRAF = requestAnimationFrame(countdownLabDrawLoop);
	else countdownLabRAF = null;
}

// Called from hideAllViews (Router.js) whenever any view changes, same convention as
// teardownReplay — stops both the digit sequence timer and the per-frame draw loop so they don't
// keep running (and logging to a canvas nobody sees) after navigating away. Also called at the start
// of every countdownLabStart (tab switches, checkbox toggles) so leftover state from whichever
// system was previously driving the canvas doesn't linger into the new one.
function teardownCountdownLab() {
	if (countdownLabSeqTimer) { clearTimeout(countdownLabSeqTimer); countdownLabSeqTimer = null; }
	if (countdownLabRAF) { cancelAnimationFrame(countdownLabRAF); countdownLabRAF = null; }
	countdownLabGlyphs = [];
	countdownLabCells = {};
	countdownLabGoAnim = null;
}
