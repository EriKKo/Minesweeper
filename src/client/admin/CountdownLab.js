// Admin "Countdown" lab (/admin/countdown) — a living preview of the round-start countdown glyph
// (see COUNTDOWN_STYLE / buildCountdownGlyphState / paintCountdownGlyph in Animations.js), looping
// 3-2-1 forever on its own small board so the effect can be reviewed without starting a real match,
// with live sliders for the same COUNTDOWN_STYLE object a real round reads — so tuning here tunes
// the actual game, not a copy of it.

var COUNTDOWN_LAB_ROWS = 16, COUNTDOWN_LAB_COLS = 20; // ranked's actual medium board
var countdownLabGlyph = null;
var countdownLabSeqTimer = null;
var countdownLabRAF = null;

function renderCountdownLab() {
	var view = document.getElementById("countdown_lab_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Countdown";
	view.appendChild(title);
	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Live preview of the round-start countdown, looping on its own board (16×20, ranked's medium size). The sliders edit COUNTDOWN_STYLE directly, so this is the exact code a real match runs.";
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
	modeHead.textContent = "Style";
	controls.appendChild(modeHead);
	var seg = document.createElement("div");
	seg.className = "cr-seg";
	var MODE_LABELS = { glow: "Glow", pressed: "Pressed in", flat: "Flat colour" };
	["glow", "pressed", "flat"].forEach(function(mode) {
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

	function addSlider(label, key, min, max, step, format) {
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
		val.textContent = format(COUNTDOWN_STYLE[key]);
		row.appendChild(val);

		var slider = document.createElement("input");
		slider.type = "range";
		slider.className = "cr-slider countdown-lab-slider";
		slider.min = String(min);
		slider.max = String(max);
		slider.step = String(step);
		slider.value = String(COUNTDOWN_STYLE[key]);
		slider.setAttribute("aria-label", label);
		slider.addEventListener("input", function() {
			COUNTDOWN_STYLE[key] = parseFloat(slider.value);
			val.textContent = format(COUNTDOWN_STYLE[key]);
		});
		row.appendChild(slider);
		controls.appendChild(row);
	}

	var colorRow = document.createElement("div");
	colorRow.className = "setting-row countdown-lab-row countdown-lab-color-row";
	var colorText = document.createElement("div");
	colorText.className = "setting-row-text";
	var colorLbl = document.createElement("span");
	colorLbl.className = "setting-row-label";
	colorLbl.textContent = "Base colour";
	colorText.appendChild(colorLbl);
	colorRow.appendChild(colorText);
	var colorVal = document.createElement("span");
	colorVal.className = "countdown-lab-val";
	colorVal.textContent = COUNTDOWN_STYLE.color;
	colorRow.appendChild(colorVal);
	var colorInput = document.createElement("input");
	colorInput.type = "color";
	colorInput.className = "countdown-lab-color";
	colorInput.value = COUNTDOWN_STYLE.color;
	colorInput.setAttribute("aria-label", "Base colour");
	colorInput.addEventListener("input", function() {
		COUNTDOWN_STYLE.color = colorInput.value;
		colorVal.textContent = colorInput.value;
	});
	colorRow.appendChild(colorInput);
	controls.appendChild(colorRow);

	var tuneHead = document.createElement("h2");
	tuneHead.className = "controls-title countdown-lab-tune-title";
	tuneHead.textContent = "Tuning";
	controls.appendChild(tuneHead);

	addSlider("Brightness", "brightness", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider("Depth (indent / bloom)", "indent", 0.2, 2, 0.05, function(v) { return v.toFixed(2) + "×"; });
	addSlider("Fade-in", "fadeInMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider("Hold", "holdMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider("Fade-out", "fadeOutMs", 100, 1000, 50, function(v) { return Math.round(v) + "ms"; });
	addSlider("Delay between numbers", "gapMs", 0, 1000, 50, function(v) { return Math.round(v) + "ms"; });

	var reset = document.createElement("button");
	reset.type = "button";
	reset.className = "btn btn-secondary keybind-reset";
	reset.textContent = "Reset to defaults";
	reset.addEventListener("click", function() {
		COUNTDOWN_STYLE.mode = "glow";
		COUNTDOWN_STYLE.fadeInMs = 0;
		COUNTDOWN_STYLE.holdMs = 500;
		COUNTDOWN_STYLE.fadeOutMs = 400;
		COUNTDOWN_STYLE.gapMs = 100;
		COUNTDOWN_STYLE.brightness = 1;
		COUNTDOWN_STYLE.indent = 1;
		COUNTDOWN_STYLE.color = "#bfdbfe";
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
	countdownLabGlyph = buildCountdownGlyphState(number, COUNTDOWN_LAB_ROWS);
	countdownLabDrawLoop();
	var tickMs = countdownTickMs();
	countdownLabSeqTimer = setTimeout(function() {
		if (number > 1) countdownLabStep(number - 1);
		else countdownLabSeqTimer = setTimeout(function() { countdownLabStep(3); }, 700);
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
	var stillGoing = paintCountdownGlyph(ctx, sw, sh, COUNTDOWN_LAB_ROWS, COUNTDOWN_LAB_COLS, countdownLabGlyph, null);
	if (stillGoing) countdownLabRAF = requestAnimationFrame(countdownLabDrawLoop);
	else countdownLabRAF = null;
}

// Called from hideAllViews (Router.js) whenever any view changes, same convention as
// teardownReplay — stops both the digit sequence timer and the per-frame draw loop so they don't
// keep running (and logging to a canvas nobody sees) after navigating away.
function teardownCountdownLab() {
	if (countdownLabSeqTimer) { clearTimeout(countdownLabSeqTimer); countdownLabSeqTimer = null; }
	if (countdownLabRAF) { cancelAnimationFrame(countdownLabRAF); countdownLabRAF = null; }
	countdownLabGlyph = null;
}
