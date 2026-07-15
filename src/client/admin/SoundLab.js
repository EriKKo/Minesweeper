// Admin "Sound Lab" (/admin/sounds) — every sound effect the game has, each with its own Play
// button, plus a shared playback-rate slider for auditioning a clip snappier or more drawn-out
// without touching its pitch. Three sections: the real sound.* methods (Sound.js) that ship in
// gameplay, played exactly as they'd play in a match; alternate takes on the idle→ready sweep
// sound (sound.sweep — currently "Shimmer"), built from the same sound.lab.tone/arp primitives
// Sound.js itself uses; and the "Battle theme lab" — independent timbre/rhythm/progression
// pickers for the battle theme's bass (music.lab.pulseBass in Music.js), looping whichever
// combination is selected instead of a fixed list of presets.

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

// ---- battle theme lab: timbre × rhythm × progression, combinable and playable together --------
// Three independent axes instead of a flat list of presets, so "does Sub Growl sound better with
// a syncopated rhythm" is something you can actually check rather than compare in your head. Each
// axis is a segmented picker (.cr-seg, same widget CountdownLab.js's style pickers use); the one
// Play/Stop button below combines whichever option is currently selected on each axis, and
// changing a picker mid-loop takes effect on the NEXT bar rather than requiring a restart — same
// "live" feel as the Playback speed slider above. Bass only — doesn't touch arp/drums.
var BASS_PREVIEW_GAIN = 0.24;

// -- timbres: per-note synthesis, signature (ctx, master, freq, t, dur, gain) — same shape for
// every one so any timbre can drive any rhythm below without special-casing.

// music.lab.pulseBass's real signature is (freq, t, dur, gain) — it reaches its own ctx/master
// via Music.js's closure, unlike the shared (ctx, master, freq, t, dur, gain) shape here. This
// adapts it rather than special-casing the caller, so it's a drop-in like every other timbre.
function playPulseBass(ctx, master, freq, t, dur, gain) {
	music.lab.pulseBass(freq, t, dur, gain);
}

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

// Same envelope shape as the shipped bass, sawtooth instead of square — brighter, more harmonic
// content, a more aggressive/driving character.
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

// Sawtooth through an LFO-wobbled resonant filter — dubstep-lite "wub" texture. Used to be baked
// into a whole bar's worth of sustained per-beat notes as its own preset; now it's just a voice,
// so it can pair with any rhythm below (including the original sustained feel via Four-on-the-
// floor) instead of only the one pattern it originally shipped alongside.
function bassWobbleFilter(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sawtooth";
	osc.frequency.value = freq;
	var filt = ctx.createBiquadFilter();
	filt.type = "lowpass";
	filt.Q.value = 9;
	filt.frequency.value = 550;
	var lfo = ctx.createOscillator();
	lfo.type = "sine";
	lfo.frequency.value = 5.5;
	var lfoGain = ctx.createGain();
	lfoGain.gain.value = 420;
	lfo.connect(lfoGain); lfoGain.connect(filt.frequency);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + Math.min(0.012, dur * 0.2));
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	osc.connect(filt); filt.connect(g); g.connect(master);
	lfo.start(t); lfo.stop(t + dur + 0.02);
	osc.start(t); osc.stop(t + dur + 0.02);
}

var BATTLE_LAB_TIMBRES = [
	{ id: "pulse", label: "Pulse", desc: "Square wave with a fast lowpass sweep — the shipped bass's own voice.", synth: playPulseBass },
	{ id: "subgrowl", label: "Sub Growl", desc: "The same square pulse, layered with a sine an octave down — warmer, less thin.", synth: bassSubGrowl },
	{ id: "saw", label: "Sawtooth Drive", desc: "Sawtooth instead of square, same envelope — brighter, more aggressive.", synth: bassSaw },
	{ id: "wobble", label: "Wobble Filter", desc: "Sawtooth through an LFO-wobbled resonant filter — a dubstep-lite \"wub\".", synth: bassWobbleFilter }
];

// -- rhythms: schedule(synthFn, ctx, master, freq, barStartT, beatS, gain), one call per bar,
// each responsible for calling synthFn as many times as its own pattern needs.
function rhythmStraight16(synthFn, ctx, master, freq, t, beatS, gain) {
	var sixteenth = beatS * 0.25;
	for (var s = 0; s < 16; s++) {
		var accent = (s % 4 === 0) ? 1.0 : (s % 2 === 0 ? 0.55 : 0.4);
		synthFn(ctx, master, freq, t + s * sixteenth, sixteenth * 0.85, gain * accent);
	}
}
function rhythmFourFloor(synthFn, ctx, master, freq, t, beatS, gain) {
	for (var b = 0; b < 4; b++) synthFn(ctx, master, freq, t + b * beatS, beatS * 0.92, gain);
}
// A classic push-off-the-beat feel: hits land early on some off-beats instead of squarely on
// every quarter or sixteenth.
function rhythmSyncopated(synthFn, ctx, master, freq, t, beatS, gain) {
	var hits = [
		{ at: 0,    dur: 0.9,  g: 1.0 },
		{ at: 0.75, dur: 0.4,  g: 0.6 },
		{ at: 1.5,  dur: 0.4,  g: 0.85 },
		{ at: 2.25, dur: 0.4,  g: 0.55 },
		{ at: 3,    dur: 0.9,  g: 0.9 },
		{ at: 3.75, dur: 0.4,  g: 0.5 }
	];
	hits.forEach(function(h) { synthFn(ctx, master, freq, t + h.at * beatS, h.dur * beatS, gain * h.g); });
}
function rhythmOctaveBounce(synthFn, ctx, master, freq, t, beatS, gain) {
	var sixteenth = beatS * 0.25;
	for (var s = 0; s < 16; s++) {
		var accent = (s % 4 === 0) ? 1.0 : (s % 2 === 0 ? 0.55 : 0.4);
		var f = (s % 2 === 1) ? freq * 2 : freq;
		synthFn(ctx, master, f, t + s * sixteenth, sixteenth * 0.85, gain * accent);
	}
}
function rhythmHalfTime(synthFn, ctx, master, freq, t, beatS, gain) {
	var eighth = beatS * 0.5;
	for (var e = 0; e < 8; e++) {
		var accent = (e % 2 === 0) ? 1.0 : 0.55;
		synthFn(ctx, master, freq, t + e * eighth, eighth * 0.88, gain * accent);
	}
}

var BATTLE_LAB_RHYTHMS = [
	{ id: "straight16", label: "Straight 16ths", desc: "16 evenly-spaced hits per bar, loud on the downbeats — the shipped rhythm.", schedule: rhythmStraight16 },
	{ id: "fourfloor", label: "Four-on-the-floor", desc: "One sustained note per beat instead of 16 short hits — steadier, more spacious.", schedule: rhythmFourFloor },
	{ id: "syncopated", label: "Syncopated", desc: "Hits push ahead of some beats instead of landing squarely on them — more of a groove, less of a pulse.", schedule: rhythmSyncopated },
	{ id: "octavebounce", label: "Octave Bounce", desc: "Same 16 hits as Straight 16ths, alternating root / octave-up — a bouncier, more melodic \"oom-pah\" line.", schedule: rhythmOctaveBounce },
	{ id: "halftime", label: "Half-time 8ths", desc: "8 hits per bar instead of 16 — half the density, a heavier, more deliberate feel.", schedule: rhythmHalfTime }
];

// -- progressions: 4 chord roots (Hz) replacing Am-F-C-G, same A-minor/C-major key centre so any
// of these still fit the rest of the theme (arp/lead) if one ever gets promoted to ship.
var BATTLE_LAB_PROGRESSIONS = [
	{ id: "amfcg", label: "Am–F–C–G", desc: "The \"axis of awesome\" progression — what the battle theme plays today.", roots: [110.00, 87.31, 130.81, 98.00] },
	{ id: "amgcf", label: "Am–G–C–F", desc: "Same four chords, reordered — resolves to F instead of G, a softer landing each loop.", roots: [110.00, 98.00, 130.81, 87.31] },
	{ id: "amdmgc", label: "Am–Dm–G–C", desc: "Descends through the circle of fifths — a more cinematic, driving pull toward C.", roots: [110.00, 73.42, 98.00, 130.81] },
	{ id: "amemfc", label: "Am–Em–F–C", desc: "Swaps in Em for the second chord — moodier, more melancholic than the shipped version.", roots: [110.00, 82.41, 87.31, 130.81] },
	{ id: "cgamf", label: "C–G–Am–F", desc: "The classic four-chord pop progression, same key centre — opens major instead of minor.", roots: [130.81, 98.00, 110.00, 87.31] }
];

// The currently selected option on each axis — persists across re-renders of this page within
// the same session (not that a re-render normally happens without a full navigate-away/back,
// which resets playback anyway via teardownSoundLab).
var battleLabSelected = { timbre: BATTLE_LAB_TIMBRES[0], rhythm: BATTLE_LAB_RHYTHMS[0], progression: BATTLE_LAB_PROGRESSIONS[0] };
var battleLabTimer = null;
var battleLabBarIdx = 0;
var battleLabPlaying = false;
var battleLabPlayBtn = null;

function stopBattleLab() {
	if (battleLabTimer) { clearTimeout(battleLabTimer); battleLabTimer = null; }
	battleLabPlaying = false;
	if (battleLabPlayBtn) {
		battleLabPlayBtn.textContent = "▶ Play combination";
		battleLabPlayBtn.classList.remove("active");
	}
}

function startBattleLab() {
	stopBattleLab();
	battleLabPlaying = true;
	if (battleLabPlayBtn) {
		battleLabPlayBtn.textContent = "■ Stop";
		battleLabPlayBtn.classList.add("active");
	}
	battleLabBarIdx = 0;
	playBattleLabBar();
}

// Loops the selected progression through the selected rhythm/timbre, one bar at a time via a
// setTimeout chain (same idiom as Overlay.js's countdownDigitCycle) — Stop just clears the
// pending timer; the current bar's already-scheduled notes finish naturally, well under 2s.
// Reads battleLabSelected fresh every bar, so switching any axis mid-loop takes effect on the
// very next bar instead of requiring a restart.
function playBattleLabBar() {
	var ctx = music.lab.getCtx();
	var master = music.lab.getMaster();
	if (!ctx || !master) return;
	var rate = sound.getRate();
	var beatS = music.lab.BEAT_S / rate;
	var barDurMs = (music.lab.BAR_DUR / rate) * 1000;
	var progression = battleLabSelected.progression;
	var root = progression.roots[battleLabBarIdx % progression.roots.length];
	var t = ctx.currentTime + 0.05;
	battleLabSelected.rhythm.schedule(battleLabSelected.timbre.synth, ctx, master, root, t, beatS, BASS_PREVIEW_GAIN);
	battleLabBarIdx++;
	battleLabTimer = setTimeout(playBattleLabBar, barDurMs);
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
	view.appendChild(buildBattleLabSection());
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

// One segmented picker (.cr-seg, same widget style CountdownLab.js's pickers use): a row of
// buttons, one active at a time, calling onChange(option) when the selection changes.
function buildBattleLabSeg(options, selectedId, onChange) {
	var seg = document.createElement("div");
	seg.className = "cr-seg sound-lab-seg";
	options.forEach(function(opt) {
		var btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = opt.label;
		if (opt.id === selectedId) btn.classList.add("active");
		btn.addEventListener("click", function() {
			var siblings = seg.querySelectorAll("button");
			for (var i = 0; i < siblings.length; i++) siblings[i].classList.remove("active");
			btn.classList.add("active");
			onChange(opt);
		});
		seg.appendChild(btn);
	});
	return seg;
}

// One axis of the combinator: a label, the currently-selected option's description, and its
// picker. selected[key] is read/written directly so playBattleLabBar always sees the live pick.
function buildBattleLabAxis(label, options, selected, key) {
	var axis = document.createElement("div");
	axis.className = "sound-lab-axis";

	var lbl = document.createElement("div");
	lbl.className = "sound-lab-axis-label";
	lbl.textContent = label;
	axis.appendChild(lbl);

	var desc = document.createElement("p");
	desc.className = "sound-lab-axis-desc";
	desc.textContent = selected[key].desc;
	axis.appendChild(desc);

	axis.appendChild(buildBattleLabSeg(options, selected[key].id, function(opt) {
		selected[key] = opt;
		desc.textContent = opt.desc;
	}));

	return axis;
}

// The "Battle theme lab" card: three independent axis pickers (Timbre / Rhythm / Progression)
// feeding the one combined Play/Stop loop in playBattleLabBar.
function buildBattleLabSection() {
	var section = document.createElement("div");
	section.className = "sound-lab-section";
	var head = document.createElement("h2");
	head.className = "controls-title";
	head.textContent = "Battle theme lab";
	section.appendChild(head);
	var sp = document.createElement("p");
	sp.className = "sound-lab-section-sub";
	sp.textContent = "Bass only, so far. Timbre, rhythm, and chord progression are independent choices — pick one of each and play the combination, not just the five presets from before. Looping the current selection until you stop it; switching a picker mid-loop takes effect on the next bar.";
	section.appendChild(sp);

	var card = document.createElement("div");
	card.className = "section-card sound-lab-battle-card";

	card.appendChild(buildBattleLabAxis("Timbre", BATTLE_LAB_TIMBRES, battleLabSelected, "timbre"));
	card.appendChild(buildBattleLabAxis("Rhythm", BATTLE_LAB_RHYTHMS, battleLabSelected, "rhythm"));
	card.appendChild(buildBattleLabAxis("Progression", BATTLE_LAB_PROGRESSIONS, battleLabSelected, "progression"));

	var playBtn = document.createElement("button");
	playBtn.type = "button";
	playBtn.className = "btn btn-secondary sound-lab-play-btn sound-lab-battle-play-btn";
	playBtn.textContent = battleLabPlaying ? "■ Stop" : "▶ Play combination";
	if (battleLabPlaying) playBtn.classList.add("active");
	battleLabPlayBtn = playBtn;
	playBtn.addEventListener("click", function() {
		if (typeof unlockAudio === "function") unlockAudio();
		if (battleLabPlaying) stopBattleLab();
		else startBattleLab();
	});
	card.appendChild(playBtn);

	section.appendChild(card);
	return section;
}

// Called from hideAllViews (Router.js) whenever any view changes — same convention as
// teardownCountdownLab. Stops any looping battle-lab preview (else it would keep scheduling bars
// against a view no longer on screen) and resets the shared playback rate to 1, the only other
// state this page touches outside itself.
function teardownSoundLab() {
	stopBattleLab();
	sound.setRate(1);
}
