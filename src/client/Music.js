// Procedural battle/synthwave soundtrack for MSBattle, generated live by
// the Web Audio API. Driving 120 BPM groove in E minor — pumping
// sawtooth bass, plucked chord stabs, always-on kick/snare, with a lead
// melody and hi-hat that layer in as the player gets active.
//
// Activity-adaptive: game code calls `music.pulse()` on player actions
// (Animations.js wires this). A rolling 4s window converts the pulse
// rate to a 0..1 intensity which scales the louder layers.
//
// Mute/volume persist via localStorage; both the topbar 🔊 popover
// and the dedicated `Music` slider drive them.

var music = (function() {
	var ctx = null, master = null, masterLP = null;
	var muted = localStorage.getItem("ms_music_muted") === "1";
	var volume = parseFloat(localStorage.getItem("ms_music_volume"));
	if (isNaN(volume)) volume = 0.22;
	var started = false;
	var nextBarTime = 0;
	var barIdx = 0;
	var schedulerHandle = null;
	var activity = [];

	var BPM = 120;
	var BEAT_S = 60 / BPM;            // 0.5s
	var BAR_BEATS = 4;
	var BAR_DUR = BEAT_S * BAR_BEATS; // 2.0s
	var LOOKAHEAD_S = 1.0;
	var ACTIVITY_WINDOW_MS = 4000;
	var ACTIVITY_FULL_RATE = 3;

	// 4-bar progression in E minor: Em - C - G - D (i - VI - III - VII).
	// Classic "epic" loop; each chord exposes its bass root, a triad in
	// the mid octave for stabs, and a 4-note lead motif on top.
	var BARS = [
		{ // Em
			bassRoot: 82.41,
			stabs:    [164.81, 196.00, 246.94],
			lead:     [329.63, 392.00, 493.88, 392.00] // E G B G
		},
		{ // C
			bassRoot: 65.41,
			stabs:    [130.81, 164.81, 196.00],
			lead:     [329.63, 392.00, 523.25, 392.00] // E G C G
		},
		{ // G
			bassRoot: 98.00,
			stabs:    [196.00, 246.94, 293.66],
			lead:     [392.00, 493.88, 587.33, 493.88] // G B D B
		},
		{ // D
			bassRoot: 73.42,
			stabs:    [146.83, 185.00, 220.00],
			lead:     [369.99, 440.00, 587.33, 440.00] // F# A D A
		}
	];

	function ensure() {
		if (ctx) return ctx;
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = muted ? 0 : volume;
		// Global low-pass — opens up with intensity for a "filter-sweep"
		// feel as the action picks up.
		masterLP = ctx.createBiquadFilter();
		masterLP.type = "lowpass";
		masterLP.frequency.value = 2200;
		master.connect(masterLP);
		masterLP.connect(ctx.destination);
		return ctx;
	}

	function pulse() {
		var t = (ctx ? ctx.currentTime * 1000 : performance.now());
		activity.push(t);
		if (activity.length > 200) activity.shift();
	}

	function intensity() {
		var now = (ctx ? ctx.currentTime * 1000 : performance.now());
		while (activity.length && now - activity[0] > ACTIVITY_WINDOW_MS) activity.shift();
		var rate = activity.length / (ACTIVITY_WINDOW_MS / 1000);
		return Math.min(1, rate / ACTIVITY_FULL_RATE);
	}

	// Sawtooth bass plucks with a quick filter envelope — that "pumping"
	// synthwave bass feel.
	function bassPluck(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sawtooth";
		osc.frequency.value = freq;
		var filt = ctx.createBiquadFilter();
		filt.type = "lowpass";
		filt.frequency.setValueAtTime(900, t);
		filt.frequency.exponentialRampToValueAtTime(180, t + dur * 0.7);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(filt); filt.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	// Plucked chord stab — three triangle waves sharing an envelope.
	function chordStab(freqs, t, dur, gain) {
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.01);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		g.connect(master);
		for (var i = 0; i < freqs.length; i++) {
			var osc = ctx.createOscillator();
			osc.type = "triangle";
			osc.frequency.value = freqs[i];
			osc.connect(g);
			osc.start(t); osc.stop(t + dur + 0.02);
		}
	}

	function lead(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "square";
		osc.frequency.value = freq;
		var filt = ctx.createBiquadFilter();
		filt.type = "lowpass";
		filt.frequency.value = 2800;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.01);
		g.gain.linearRampToValueAtTime(gain * 0.6, t + dur * 0.6);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(filt); filt.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	function kick(t, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(150, t);
		osc.frequency.exponentialRampToValueAtTime(45, t + 0.13);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + 0.22);
	}

	function snare(t, gain) {
		var dur = 0.18;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 1.6);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var bp = ctx.createBiquadFilter();
		bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 0.7;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.003);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
		src.connect(bp); bp.connect(g); g.connect(master);
		src.start(t);
	}

	function hihat(t, gain) {
		var dur = 0.05;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 3);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var hp = ctx.createBiquadFilter();
		hp.type = "highpass"; hp.frequency.value = 7000;
		var g = ctx.createGain(); g.gain.value = gain;
		src.connect(hp); hp.connect(g); g.connect(master);
		src.start(t);
	}

	function scheduleBar(t) {
		var bar = BARS[barIdx];
		var intens = intensity();

		// Open the global filter as intensity rises so the whole mix gets
		// brighter when the player is racing.
		if (masterLP) {
			masterLP.frequency.linearRampToValueAtTime(2000 + 4000 * intens, t + BAR_DUR);
		}

		// Pumping 8th-note sawtooth bass on the root — always on, slightly
		// louder with intensity. The off-beats are half-volume for a
		// classic "doof - tss" pulse.
		var bassGain = 0.18 + 0.06 * intens;
		for (var i = 0; i < 8; i++) {
			var nt = t + i * 0.5 * BEAT_S;
			bassPluck(bar.bassRoot, nt, 0.32, bassGain * (i % 2 === 0 ? 1 : 0.55));
		}

		// Chord stabs on beats 2 and 4 (the off-beats).
		chordStab(bar.stabs, t + 1 * BEAT_S, 0.45, 0.05 + 0.04 * intens);
		chordStab(bar.stabs, t + 3 * BEAT_S, 0.45, 0.05 + 0.04 * intens);

		// Drums — light always, building with intensity.
		// Kick on every beat (1, 2, 3, 4).
		var kickGain = 0.16 + 0.10 * intens;
		for (var b = 0; b < BAR_BEATS; b++) kick(t + b * BEAT_S, kickGain);
		// Snare on beats 2 and 4 (back-beat).
		var snareGain = 0.05 + 0.10 * intens;
		snare(t + 1 * BEAT_S, snareGain);
		snare(t + 3 * BEAT_S, snareGain);

		// Hi-hat 8ths fade in past intensity 0.2.
		if (intens > 0.2) {
			var hatGain = 0.012 + 0.018 * (intens - 0.2);
			for (var h = 0; h < 8; h++) {
				hihat(t + h * 0.5 * BEAT_S, hatGain * (h % 2 === 1 ? 1.2 : 0.7));
			}
		}

		// Lead melody — square synth, 4 quarter notes per bar — fades in
		// past intensity 0.35 so chill play stays groove-only.
		if (intens > 0.35) {
			var leadGain = 0.05 + 0.08 * (intens - 0.35);
			for (var n = 0; n < 4; n++) {
				lead(bar.lead[n], t + n * BEAT_S, 0.42, leadGain);
			}
		}

		barIdx = (barIdx + 1) % BARS.length;
	}

	function scheduleAhead() {
		if (!ctx) return;
		while (nextBarTime < ctx.currentTime + LOOKAHEAD_S) {
			scheduleBar(nextBarTime);
			nextBarTime += BAR_DUR;
		}
	}

	function start() {
		ensure();
		if (!ctx) return;
		if (ctx.state === "suspended") ctx.resume();
		if (started) return;
		started = true;
		nextBarTime = ctx.currentTime + 0.25;
		scheduleAhead();
		schedulerHandle = setInterval(scheduleAhead, 400);
	}

	function setMuted(m) {
		muted = m;
		localStorage.setItem("ms_music_muted", m ? "1" : "0");
		if (master) master.gain.linearRampToValueAtTime(m ? 0 : volume, (ctx ? ctx.currentTime : 0) + 0.15);
	}
	function setVolume(v) {
		volume = v;
		localStorage.setItem("ms_music_volume", String(v));
		if (master && !muted) master.gain.linearRampToValueAtTime(v, (ctx ? ctx.currentTime : 0) + 0.15);
	}

	return {
		start: start,
		pulse: pulse,
		intensity: intensity,
		setMuted: setMuted,
		isMuted: function() { return muted; },
		setVolume: setVolume,
		getVolume: function() { return volume; }
	};
})();
