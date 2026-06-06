// Procedural music for MSBattle — a layered, adaptive engine generated
// live by the Web Audio API. The base groove (pad + bass) always plays;
// arpeggio, kick, and shaker layers fade in as the player's activity
// rises so the soundtrack feels like it's reacting to how fast you're
// playing.
//
// Game code calls `music.pulse()` whenever the player does something
// (reveal, flag, chord). We track those over a short window and turn
// that rate into a 0..1 "intensity" that drives the layer mix.
//
// No external assets. Mute and volume persist via localStorage; both
// the topbar 🔊/🔇 button and a per-channel slider in the audio popover
// can drive them.

var music = (function() {
	var ctx = null, master = null;
	var muted = localStorage.getItem("ms_music_muted") === "1";
	var volume = parseFloat(localStorage.getItem("ms_music_volume"));
	if (isNaN(volume)) volume = 0.22;
	var started = false;
	var nextBarTime = 0;
	var chordIdx = 0;
	var schedulerHandle = null;
	var activity = [];

	// Tempo: 100 BPM gives a beat at 0.6s — peppy without being frantic.
	var BPM = 100;
	var BEAT_S = 60 / BPM;
	var BAR_BEATS = 4;
	var BAR_DUR = BEAT_S * BAR_BEATS; // one chord per bar
	var LOOKAHEAD_S = 1.0;
	var ACTIVITY_WINDOW_MS = 4000;
	var ACTIVITY_FULL_RATE = 3; // events/sec ≈ "fast play"

	// I-vi-IV-V in C major, voiced as seventh chords. Each chord exposes
	// its root, the pad tones, and a scale to draw arpeggio notes from.
	var CHORDS = [
		{ root: 130.81, pad: [130.81, 164.81, 196.00, 246.94], scale: [261.63, 293.66, 329.63, 392.00, 493.88] }, // Cmaj7
		{ root: 110.00, pad: [110.00, 130.81, 164.81, 196.00], scale: [220.00, 261.63, 293.66, 329.63, 440.00] }, // Am7
		{ root:  87.31, pad: [ 87.31, 110.00, 130.81, 164.81], scale: [174.61, 220.00, 261.63, 329.63, 349.23] }, // Fmaj7
		{ root:  98.00, pad: [ 98.00, 123.47, 146.83, 174.61], scale: [196.00, 246.94, 293.66, 349.23, 392.00] }  // G7
	];

	function ensure() {
		if (ctx) return ctx;
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = muted ? 0 : volume;
		var lp = ctx.createBiquadFilter();
		lp.type = "lowpass";
		lp.frequency.value = 4500;
		master.connect(lp);
		lp.connect(ctx.destination);
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
		var raw = Math.min(1, rate / ACTIVITY_FULL_RATE);
		return raw;
	}

	function padTone(type, freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = type;
		osc.frequency.value = freq;
		var g = ctx.createGain();
		var attack = 0.4, release = 0.4;
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + attack);
		g.gain.setValueAtTime(gain, t + dur - release);
		g.gain.linearRampToValueAtTime(0.0001, t + dur);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.05);
	}

	function pluck(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "triangle";
		osc.frequency.value = freq;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	function bass(freq, t, gain) {
		var osc = ctx.createOscillator();
		osc.type = "triangle";
		osc.frequency.setValueAtTime(freq, t);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.01);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + 0.4);
	}

	function kick(t, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(140, t);
		osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + 0.2);
	}

	function shaker(t, gain) {
		var dur = 0.06;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 2.5);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 6000;
		var g = ctx.createGain(); g.gain.value = gain;
		src.connect(hp); hp.connect(g); g.connect(master);
		src.start(t);
	}

	function scheduleBar(chord, t, intens) {
		// Pad — always present, fairly soft.
		var padDur = BAR_DUR + 0.5;
		padTone("triangle", chord.pad[0] * 0.5, t, padDur, 0.16);
		padTone("sine",     chord.pad[1],       t, padDur, 0.07);
		padTone("sine",     chord.pad[2],       t, padDur, 0.07);
		padTone("sine",     chord.pad[3],       t, padDur, 0.05);

		// Walking bass on beats 1 and 3 — always there but louder with intensity.
		var bassGain = 0.10 + 0.06 * intens;
		bass(chord.root, t, bassGain);
		bass(chord.root, t + 2 * BEAT_S, bassGain);

		// 8th-note arpeggio that grows with intensity (silent when idle).
		if (intens > 0.05) {
			for (var i = 0; i < 8; i++) {
				var note = chord.scale[(i + chordIdx) % chord.scale.length];
				// Occasional octave jump for sparkle when intensity is high.
				if (intens > 0.6 && (i % 2 === 0)) note *= 2;
				pluck(note, t + i * 0.5 * BEAT_S, 0.22, 0.025 + 0.06 * intens);
			}
		}

		// Soft kick — fades in past intensity 0.25.
		if (intens > 0.25) {
			var kickGain = 0.05 + 0.10 * (intens - 0.25);
			kick(t, kickGain);
			kick(t + 2 * BEAT_S, kickGain);
			// Extra back-beat kick at high intensity.
			if (intens > 0.7) kick(t + 3 * BEAT_S, kickGain * 0.7);
		}

		// Shaker — joins at higher intensity, 8th notes.
		if (intens > 0.45) {
			var shakerGain = 0.015 + 0.025 * (intens - 0.45);
			for (var s = 0; s < 8; s++) {
				shaker(t + s * 0.5 * BEAT_S, shakerGain * (s % 2 === 1 ? 1 : 0.6));
			}
		}
	}

	function scheduleAhead() {
		if (!ctx) return;
		while (nextBarTime < ctx.currentTime + LOOKAHEAD_S) {
			scheduleBar(CHORDS[chordIdx], nextBarTime, intensity());
			chordIdx = (chordIdx + 1) % CHORDS.length;
			nextBarTime += BAR_DUR;
		}
	}

	function start() {
		ensure();
		if (!ctx) return;
		if (ctx.state === "suspended") ctx.resume();
		if (started) return;
		started = true;
		nextBarTime = ctx.currentTime + 0.3;
		scheduleAhead();
		schedulerHandle = setInterval(scheduleAhead, 500);
	}

	function setMuted(m) {
		muted = m;
		localStorage.setItem("ms_music_muted", m ? "1" : "0");
		if (master) master.gain.linearRampToValueAtTime(m ? 0 : volume, (ctx ? ctx.currentTime : 0) + 0.2);
	}
	function setVolume(v) {
		volume = v;
		localStorage.setItem("ms_music_volume", String(v));
		if (master && !muted) master.gain.linearRampToValueAtTime(v, (ctx ? ctx.currentTime : 0) + 0.2);
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
