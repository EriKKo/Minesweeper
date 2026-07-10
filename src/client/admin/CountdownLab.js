// Admin "Board animations" lab (/admin/countdown) — a living preview of the round-start countdown
// glyph (see COUNTDOWN_STYLE / buildCountdownGlyphState / paintCountdownGlyph in Animations.js) and
// the "go" sweep that plays once the countdown finishes (see BOARD_GO_STYLE /
// buildBoardGoAnimState / paintBoardGoAnimation), looping forever on its own small board so both
// can be reviewed without starting a real match. The controls edit the same style objects a real
// round reads, so tuning here tunes the actual game, not a copy of it.

var COUNTDOWN_LAB_ROWS = 16, COUNTDOWN_LAB_COLS = 20; // ranked's actual medium board
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
	sub.textContent = "Live preview of the round-start countdown digit and the \"go\" sweep that follows it, looping on its own board (16×20, ranked's medium size). The controls edit COUNTDOWN_STYLE/BOARD_GO_STYLE directly, so this is the exact code a real match runs.";
	view.appendChild(sub);

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

	var modeHead = document.createElement("h2");
	modeHead.className = "controls-title";
	modeHead.textContent = "Countdown digit — style";
	controls.appendChild(modeHead);
	var seg = document.createElement("div");
	seg.className = "cr-seg";
	var MODE_LABELS = { glow: "Glow", pressed: "Pressed in", flat: "Flat colour", reveal: "Reveal numbers" };
	["glow", "pressed", "flat", "reveal"].forEach(function(mode) {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = MODE_LABELS[mode];
		btn.classList.toggle("active", COUNTDOWN_STYLE.mode === mode);
		btn.addEventListener("click", function() {
			COUNTDOWN_STYLE.mode = mode;
			seg.querySelectorAll("button").forEach(function(b) { b.classList.remove("active"); });
			btn.classList.add("active");
		});
		seg.appendChild(btn);
	});
	controls.appendChild(seg);

	// target is the live style object (COUNTDOWN_STYLE or BOARD_GO_STYLE) the row edits directly.
	function addSlider(target, label, key, min, max, step, format) {
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
		controls.appendChild(row);
	}

	function addColorPicker(target, label) {
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
		controls.appendChild(colorRow);
	}

	addColorPicker(COUNTDOWN_STYLE, "Base colour");

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
	controls.appendChild(persistRow);

	var tuneHead = document.createElement("h2");
	tuneHead.className = "controls-title countdown-lab-tune-title";
	tuneHead.textContent = "Countdown digit — tuning";
	controls.appendChild(tuneHead);

	addSlider(COUNTDOWN_STYLE, "Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider(COUNTDOWN_STYLE, "Depth (indent / bloom)", "indent", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider(COUNTDOWN_STYLE, "Fade-in", "fadeInMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(COUNTDOWN_STYLE, "Hold", "holdMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(COUNTDOWN_STYLE, "Fade-out", "fadeOutMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(COUNTDOWN_STYLE, "Delay between numbers", "gapMs", -900, 1000, 50, function(v) { return Math.round(v) + "ms"; });

	var goHead = document.createElement("h2");
	goHead.className = "controls-title countdown-lab-tune-title";
	goHead.textContent = "Go sweep — style";
	controls.appendChild(goHead);
	var goSub = document.createElement("p");
	goSub.className = "countdown-lab-go-sub";
	goSub.textContent = "Plays once, the instant the countdown finishes — purely decorative, doesn't affect when input actually unlocks.";
	controls.appendChild(goSub);
	var goSeg = document.createElement("div");
	goSeg.className = "cr-seg";
	var GO_MODE_LABELS = { diagonal: "Diagonal", radial: "Radial", rowWipe: "Row wipe", colWipe: "Col wipe" };
	["diagonal", "radial", "rowWipe", "colWipe"].forEach(function(mode) {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = GO_MODE_LABELS[mode];
		btn.classList.toggle("active", BOARD_GO_STYLE.mode === mode);
		btn.addEventListener("click", function() {
			BOARD_GO_STYLE.mode = mode;
			goSeg.querySelectorAll("button").forEach(function(b) { b.classList.remove("active"); });
			btn.classList.add("active");
		});
		goSeg.appendChild(btn);
	});
	controls.appendChild(goSeg);
	addColorPicker(BOARD_GO_STYLE, "Sweep colour");

	var goTuneHead = document.createElement("h2");
	goTuneHead.className = "controls-title countdown-lab-tune-title";
	goTuneHead.textContent = "Go sweep — tuning";
	controls.appendChild(goTuneHead);
	addSlider(BOARD_GO_STYLE, "Duration", "durationMs", 150, 2000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider(BOARD_GO_STYLE, "Width", "width", 0.5, 10, 0.5, function(v) { return v.toFixed(1) + " cells"; });
	addSlider(BOARD_GO_STYLE, "Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });

	var playGoBtn = document.createElement("button");
	playGoBtn.type = "button";
	playGoBtn.className = "btn btn-secondary countdown-lab-play-go";
	playGoBtn.textContent = "Play sweep now";
	playGoBtn.addEventListener("click", function() {
		countdownLabGoAnim = buildBoardGoAnimState();
		if (!countdownLabRAF) countdownLabDrawLoop();
	});
	controls.appendChild(playGoBtn);

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
		BOARD_GO_STYLE.brightness = 1;
		BOARD_GO_STYLE.color = "#bfdbfe";
		renderCountdownLab();
	});
	controls.appendChild(reset);

	layout.appendChild(controls);
	view.appendChild(layout);

	countdownLabStart();
}

// Loops 3 -> 2 -> 1 -> a short pause -> repeat, forever, until teardownCountdownLab stops it (see
// hideAllViews in Router.js). Mirrors countDownStep in Overlay.js — both read countdownTickMs()
// (Animations.js) each time, so a slider change mid-loop takes effect on the next tick, here and in
// a real match alike — but this one never terminates.
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

function countdownLabStart() {
	teardownCountdownLab();
	countdownLabStep(3);
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
	var stillGoing;
	if (COUNTDOWN_STYLE.persistUnchanged) {
		stillGoing = paintCountdownCells(ctx, sw, sh, countdownLabCells, null);
	} else {
		countdownLabGlyphs = paintCountdownGlyphs(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGlyphs, null);
		stillGoing = countdownLabGlyphs.length > 0;
	}
	if (countdownLabGoAnim && !paintBoardGoAnimation(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGoAnim, null)) countdownLabGoAnim = null;
	if (stillGoing || countdownLabGoAnim) countdownLabRAF = requestAnimationFrame(countdownLabDrawLoop);
	else countdownLabRAF = null;
}

// Called from hideAllViews (Router.js) whenever any view changes, same convention as
// teardownReplay — stops both the digit sequence timer and the per-frame draw loop so they don't
// keep running (and logging to a canvas nobody sees) after navigating away.
function teardownCountdownLab() {
	if (countdownLabSeqTimer) { clearTimeout(countdownLabSeqTimer); countdownLabSeqTimer = null; }
	if (countdownLabRAF) { cancelAnimationFrame(countdownLabRAF); countdownLabRAF = null; }
	countdownLabGlyphs = [];
	countdownLabCells = {};
	countdownLabGoAnim = null;
}
