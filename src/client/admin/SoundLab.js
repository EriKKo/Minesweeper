// Admin "Sound Lab" (/admin/sounds) — every sound effect the game has, each with its own Play
// button, plus a shared playback-rate slider for auditioning a clip snappier or more drawn-out
// without touching its pitch. Three sections: the real sound.* methods (Sound.js) that ship in
// gameplay, played exactly as they'd play in a match; alternate takes on the idle→ready sweep
// sound (sound.sweep — currently "Shimmer"), built from the same sound.lab.tone/arp primitives
// Sound.js itself uses; and alternate takes on the battle theme's bass (music.lab.pulseBass in
// Music.js), which loop the real Am-F-C-G progression instead of firing once — see the "Bass
// variants" section below for that preview scheduler.

// Every real gameplay sound, with the args (if any) it needs to actually make noise standalone.
var SOUND_LAB_GAME_SOUNDS = [
	{ name: "cascade", desc: "A safe cell opens more than one neighbour at once.", play: function() { sound.cascade(4); } },
	{ name: "opponentDone", desc: "An opponent finishes their board before you, in a race mode.", play: function() { sound.opponentDone(2); } },
	{ name: "flag", desc: "Placing a flag.", play: function() { sound.flag(); } },
	{ name: "unflag", desc: "Removing a flag.", play: function() { sound.unflag(); } },
	{ name: "mine", desc: "Revealing a mine.", play: function() { sound.mine(); } },
	{ name: "beep", desc: "Generic short blip — used for the 3-2-1 countdown digits.", play: function() { sound.beep(440); } },
	{ name: "sweep", desc: "The idle→ready board sweep, right as a round is about to start.", play: function() { sound.sweep(); } },
	{ name: "go", desc: "The moment a round actually goes live, at the end of the countdown.", play: function() { sound.go(); } },
	{ name: "win", desc: "You clear the board.", play: function() { sound.win(); } },
	{ name: "lose", desc: "You hit a mine and lose.", play: function() { sound.lose(); } },
	{ name: "seriesWin", desc: "You win an entire ranked series.", play: function() { sound.seriesWin(); } },
	{ name: "rankUp", desc: "You climb a rank tier.", play: function() { sound.rankUp(); } },
	{ name: "rankDown", desc: "You drop a rank tier.", play: function() { sound.rankDown(); } },
	{ name: "matchFound", desc: "A ranked queue forms a match.", play: function() { sound.matchFound(); } }
];

// Alternate takes on sound.sweep — all built from sound.lab.tone (the exact primitive Sound.js
// itself uses), so a candidate here is byte-for-byte what would ship if picked. "Shimmer" is the
// one that actually ships today; the others are open comparisons, not proposals ranked in order.
var SOUND_LAB_SWEEP_VARIANTS = [
	{
		name: "Shimmer",
		badge: "Shipped",
		desc: "Seven-note ascending arpeggio, evenly spaced. What sound.sweep() plays today.",
		play: function() {
			var freqs = [392, 440, 523, 587, 659, 784, 880];
			playArp(freqs, 0.09, 0.17, 0.065);
		}
	},
	{
		name: "Shimmer — Wide",
		desc: "Fewer notes with bigger jumps between them, spaced further apart — more of a sweep, less of a twinkle.",
		play: function() {
			var freqs = [330, 440, 587, 784, 1047];
			playArp(freqs, 0.12, 0.22, 0.07);
		}
	},
	{
		name: "Shimmer — Dense",
		desc: "Ten notes packed tightly — a smoother, faster cascade of sparkle instead of a clear staircase.",
		play: function() {
			var freqs = [392, 440, 494, 523, 587, 659, 698, 784, 880, 988];
			playArp(freqs, 0.055, 0.13, 0.05);
		}
	},
	{
		name: "Shimmer — Bloom",
		desc: "Same seven notes as the shipped version, but held long enough to overlap into a chordal bloom rather than a staircase.",
		play: function() {
			var freqs = [392, 440, 523, 587, 659, 784, 880];
			playArp(freqs, 0.05, 0.35, 0.045);
		}
	}
];

function playArp(freqs, step, dur, gain) {
	for (var i = 0; i < freqs.length; i++) {
		sound.lab.tone({ type: "triangle", freq: freqs[i], dur: dur, gain: gain, delay: i * step });
	}
}

// ---- battle theme bass variants -------------------------------------------------------------
// Each hit-based variant (the default schedule below) matches pulseBass's own signature —
// (ctx, master, freq, t, dur, gain) — so it's a drop-in replacement for the real bass synth if
// picked. "Wobble" is enough of a rhythmic departure (sustained per-beat notes instead of 16
// short hits) that it supplies its own schedule(ctx, master, bar, t) instead.
var BASS_PREVIEW_GAIN = 0.24;

// Square pulse layered with a sine one octave down for more low-end weight — warmer, less thin
// than the shipped bass, at the cost of a bit of the original's crisp "doof" attack.
function bassSubGrowl(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "square";
	osc.frequency.value = freq;
	var filt = ctx.createBiquadFilter();
	filt.type = "lowpass";
	filt.frequency.setValueAtTime(700, t);
	filt.frequency.exponentialRampToValueAtTime(220, t + dur * 0.9);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 0.55, t + 0.004);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	osc.connect(filt); filt.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + dur + 0.02);

	var sub = ctx.createOscillator();
	sub.type = "sine";
	sub.frequency.value = freq / 2;
	var gs = ctx.createGain();
	gs.gain.setValueAtTime(0.0001, t);
	gs.gain.linearRampToValueAtTime(gain * 0.65, t + 0.006);
	gs.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.15);
	sub.connect(gs); gs.connect(master);
	sub.start(t); sub.stop(t + dur * 1.15 + 0.02);
}

// Same rhythm and envelope shape as the shipped bass, sawtooth instead of square — brighter,
// more harmonic content, a more aggressive/driving character.
function bassSaw(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sawtooth";
	osc.frequency.value = freq;
	var filt = ctx.createBiquadFilter();
	filt.type = "lowpass";
	filt.frequency.setValueAtTime(1100, t);
	filt.frequency.exponentialRampToValueAtTime(320, t + dur * 0.7);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 0.85, t + 0.003);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	osc.connect(filt); filt.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + dur + 0.02);
}

// A bigger departure from the 16th-note pulse pattern: one sustained sawtooth note per beat (4
// per bar instead of 16), with an LFO wobbling the filter cutoff — dubstep-lite "wub" texture.
// beatS is the caller's already rate-scaled beat length (see playBassBar), not music.lab.BEAT_S
// directly, so this speeds up/slows down along with the shared "Playback speed" slider too.
function bassWobbleSchedule(ctx, master, bar, t, beatS) {
	for (var b = 0; b < 4; b++) {
		var noteT = t + b * beatS;
		var dur = beatS * 0.92;
		var osc = ctx.createOscillator();
		osc.type = "sawtooth";
		osc.frequency.value = bar.bassRoot;
		var filt = ctx.createBiquadFilter();
		filt.type = "lowpass";
		filt.Q.value = 9;
		filt.frequency.value = 550;
		var lfo = ctx.createOscillator();
		lfo.type = "sine";
		lfo.frequency.value = 5.5;
		var lfoGain = ctx.createGain();
		lfoGain.gain.value = 480;
		lfo.connect(lfoGain); lfoGain.connect(filt.frequency);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, noteT);
		g.gain.linearRampToValueAtTime(0.16, noteT + 0.012);
		g.gain.exponentialRampToValueAtTime(0.0001, noteT + dur);
		osc.connect(filt); filt.connect(g); g.connect(master);
		lfo.start(noteT); lfo.stop(noteT + dur + 0.02);
		osc.start(noteT); osc.stop(noteT + dur + 0.02);
	}
}

// music.lab.pulseBass's real signature is (freq, t, dur, gain) — it reaches its own ctx/master
// via Music.js's closure, unlike the (ctx, master, freq, t, dur, gain) shape the other variants
// here take. This adapts it to that shared shape rather than special-casing the caller.
function playPulseBass(ctx, master, freq, t, dur, gain) {
	music.lab.pulseBass(freq, t, dur, gain);
}

var SOUND_LAB_BASS_VARIANTS = [
	{
		name: "Pulse",
		badge: "Shipped",
		desc: "Square wave with a fast lowpass sweep, straight 16th notes. What the battle theme's bass plays today.",
		play: playPulseBass
	},
	{
		name: "Sub Growl",
		desc: "The same square pulse, layered with a sine an octave down for more low-end weight — warmer, less thin.",
		play: bassSubGrowl
	},
	{
		name: "Sawtooth Drive",
		desc: "Same rhythm and envelope as Pulse, sawtooth instead of square — brighter, more aggressive.",
		play: bassSaw
	},
	{
		name: "Octave Bounce",
		desc: "Same square pulse, but alternates root / octave-up on every other 16th note — a bouncier, more melodic \"oom-pah\" line.",
		play: playPulseBass,
		octaveBounce: true
	},
	{
		name: "Wobble",
		desc: "A bigger departure: sustained sawtooth notes, one per beat, with an LFO-wobbled filter instead of 16 short hits.",
		schedule: bassWobbleSchedule
	}
];

// The default per-bar schedule for a hit-based variant: the real bassline's own 16th-note
// accent pattern (downbeats loudest, off-beats quietest) from Music.js's scheduleBar, driving
// whichever synth function the variant supplies. octaveBounce alternates the frequency instead
// of changing the rhythm, so it's just a per-note tweak on top of the same pattern. beatS is
// already rate-scaled by the caller (see playBassBar).
function defaultBassSchedule(ctx, master, bar, t, variant, beatS) {
	var sixteenth = beatS * 0.25;
	for (var s = 0; s < 16; s++) {
		var accent = (s % 4 === 0) ? 1.0 : (s % 2 === 0 ? 0.55 : 0.4);
		var freq = (variant.octaveBounce && s % 2 === 1) ? bar.bassRoot * 2 : bar.bassRoot;
		variant.play(ctx, master, freq, t + s * sixteenth, sixteenth * 0.85, BASS_PREVIEW_GAIN * accent);
	}
}

// Loops the real 4-bar Am-F-C-G progression through whichever variant is playing, one bar at a
// time via a setTimeout chain (same idiom as Overlay.js's countdownDigitCycle) rather than
// scheduling everything up front — that makes Stop trivial (just clear the pending timer; the
// current bar's already-scheduled notes finish naturally, well under 2s) instead of needing to
// track and individually stop dozens of live oscillator nodes.
var bassPreviewTimer = null;
var bassPreviewBarIdx = 0;
var bassPreviewActiveBtn = null;

function stopBassPreview() {
	if (bassPreviewTimer) { clearTimeout(bassPreviewTimer); bassPreviewTimer = null; }
	if (bassPreviewActiveBtn) {
		bassPreviewActiveBtn.textContent = "▶ Play";
		bassPreviewActiveBtn.classList.remove("active");
		bassPreviewActiveBtn = null;
	}
}

function startBassPreview(variant, btn) {
	stopBassPreview();
	bassPreviewActiveBtn = btn;
	btn.textContent = "■ Stop";
	btn.classList.add("active");
	bassPreviewBarIdx = 0;
	playBassBar(variant);
}

function playBassBar(variant) {
	var ctx = music.lab.getCtx();
	var master = music.lab.getMaster();
	if (!ctx || !master) return;
	var bar = music.lab.BARS[bassPreviewBarIdx % music.lab.BARS.length];
	// Same "Playback speed" slider the one-shot sounds above use (sound.setRate) — stretches or
	// compresses the loop's tempo along with everything else on the page, not pitch.
	var rate = sound.getRate();
	var beatS = music.lab.BEAT_S / rate;
	var barDurMs = (music.lab.BAR_DUR / rate) * 1000;
	var t = ctx.currentTime + 0.05;
	if (variant.schedule) variant.schedule(ctx, master, bar, t, beatS);
	else defaultBassSchedule(ctx, master, bar, t, variant, beatS);
	bassPreviewBarIdx++;
	bassPreviewTimer = setTimeout(function() { playBassBar(variant); }, barDurMs);
}

function renderSoundLab() {
	var view = document.getElementById("sound_lab_view");
	if (!view) return;
	view.innerHTML = "";

	var title = document.createElement("h1");
	title.className = "section-page-title";
	title.textContent = "Sound Lab";
	view.appendChild(title);
	var sub = document.createElement("p");
	sub.className = "section-page-sub";
	sub.textContent = "Every sound effect the game has, each with its own Play button, at a speed you can dial up or down. The clips below call the exact code that ships — this isn't a copy of it.";
	view.appendChild(sub);

	var rateCard = document.createElement("div");
	rateCard.className = "section-card sound-lab-rate-card";
	var rateHead = document.createElement("h2");
	rateHead.className = "controls-title";
	rateHead.textContent = "Playback speed";
	rateCard.appendChild(rateHead);
	var rateRow = document.createElement("div");
	rateRow.className = "setting-row sound-lab-rate-row";
	var rateText = document.createElement("div");
	rateText.className = "setting-row-text";
	var rateLbl = document.createElement("span");
	rateLbl.className = "setting-row-label";
	rateLbl.textContent = "Speed";
	var rateNote = document.createElement("span");
	rateNote.className = "setting-row-note";
	rateNote.textContent = "Stretches or compresses timing only — pitch stays put. Applies to every Play button below. Resets to 1× when you leave this page.";
	rateText.appendChild(rateLbl);
	rateText.appendChild(rateNote);
	rateRow.appendChild(rateText);
	var rateVal = document.createElement("span");
	rateVal.className = "sound-lab-rate-val";
	rateVal.textContent = sound.getRate().toFixed(2) + "×";
	rateRow.appendChild(rateVal);
	var rateSlider = document.createElement("input");
	rateSlider.type = "range";
	rateSlider.className = "cr-slider sound-lab-rate-slider";
	rateSlider.min = "0.25";
	rateSlider.max = "2.5";
	rateSlider.step = "0.05";
	rateSlider.value = String(sound.getRate());
	rateSlider.setAttribute("aria-label", "Playback speed");
	rateSlider.addEventListener("input", function() {
		var v = parseFloat(rateSlider.value);
		sound.setRate(v);
		rateVal.textContent = v.toFixed(2) + "×";
	});
	rateRow.appendChild(rateSlider);
	rateCard.appendChild(rateRow);
	view.appendChild(rateCard);

	view.appendChild(buildSoundLabSection("Game sounds", "Exactly what plays in a real match.", SOUND_LAB_GAME_SOUNDS));
	view.appendChild(buildSoundLabSection("Sweep variants", "Alternate takes on the idle→ready sweep (sound.sweep) — for comparing candidates, not a proposal ranked in order.", SOUND_LAB_SWEEP_VARIANTS));
	view.appendChild(buildBassLabSection("Bass variants", "Alternate takes on the battle theme's bass (music.lab.pulseBass), looping the real Am-F-C-G progression until you stop it or start a different one.", SOUND_LAB_BASS_VARIANTS));
}

function buildSoundLabSection(title, sub, items) {
	var section = document.createElement("div");
	section.className = "sound-lab-section";
	var head = document.createElement("h2");
	head.className = "controls-title";
	head.textContent = title;
	section.appendChild(head);
	var sp = document.createElement("p");
	sp.className = "sound-lab-section-sub";
	sp.textContent = sub;
	section.appendChild(sp);

	var grid = document.createElement("div");
	grid.className = "sound-lab-grid";
	items.forEach(function(item) {
		var card = document.createElement("div");
		card.className = "section-card sound-lab-card";

		var head2 = document.createElement("div");
		head2.className = "sound-lab-card-head";
		var name = document.createElement("span");
		name.className = "sound-lab-card-name";
		name.textContent = item.name;
		head2.appendChild(name);
		if (item.badge) {
			var badge = document.createElement("span");
			badge.className = "sound-lab-card-badge";
			badge.textContent = item.badge;
			head2.appendChild(badge);
		}
		card.appendChild(head2);

		var desc = document.createElement("p");
		desc.className = "sound-lab-card-desc";
		desc.textContent = item.desc;
		card.appendChild(desc);

		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn btn-secondary sound-lab-play-btn";
		btn.textContent = "▶ Play";
		btn.addEventListener("click", function() {
			if (typeof unlockAudio === "function") unlockAudio();
			item.play();
		});
		card.appendChild(btn);

		grid.appendChild(card);
	});
	section.appendChild(grid);
	return section;
}

// Same layout as buildSoundLabSection, but each card's button is a Play/Stop toggle instead of
// a one-shot trigger — a bass variant loops until stopped. Starting one stops whatever else was
// playing first (startBassPreview), so only one loop is ever live at a time.
function buildBassLabSection(title, sub, items) {
	var section = document.createElement("div");
	section.className = "sound-lab-section";
	var head = document.createElement("h2");
	head.className = "controls-title";
	head.textContent = title;
	section.appendChild(head);
	var sp = document.createElement("p");
	sp.className = "sound-lab-section-sub";
	sp.textContent = sub;
	section.appendChild(sp);

	var grid = document.createElement("div");
	grid.className = "sound-lab-grid";
	items.forEach(function(item) {
		var card = document.createElement("div");
		card.className = "section-card sound-lab-card";

		var head2 = document.createElement("div");
		head2.className = "sound-lab-card-head";
		var name = document.createElement("span");
		name.className = "sound-lab-card-name";
		name.textContent = item.name;
		head2.appendChild(name);
		if (item.badge) {
			var badge = document.createElement("span");
			badge.className = "sound-lab-card-badge";
			badge.textContent = item.badge;
			head2.appendChild(badge);
		}
		card.appendChild(head2);

		var desc = document.createElement("p");
		desc.className = "sound-lab-card-desc";
		desc.textContent = item.desc;
		card.appendChild(desc);

		var btn = document.createElement("button");
		btn.type = "button";
		btn.className = "btn btn-secondary sound-lab-play-btn";
		btn.textContent = "▶ Play";
		btn.addEventListener("click", function() {
			if (typeof unlockAudio === "function") unlockAudio();
			if (bassPreviewActiveBtn === btn) { stopBassPreview(); return; }
			startBassPreview(item, btn);
		});
		card.appendChild(btn);

		grid.appendChild(card);
	});
	section.appendChild(grid);
	return section;
}

// Called from hideAllViews (Router.js) whenever any view changes — same convention as
// teardownCountdownLab. Stops any looping bass preview (else it would keep scheduling bars
// against a view no longer on screen) and resets the shared playback rate to 1, the only other
// state this page touches outside itself.
function teardownSoundLab() {
	stopBassPreview();
	sound.setRate(1);
}
