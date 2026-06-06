// Procedural chiptune-style soundtrack for MSBattle, generated live by
// the Web Audio API. Inspired by "bassloom — pixel pulse": 128 BPM in
// A minor with an Am-F-C-G progression, pulse-wave bass on 16th notes,
// square-wave arpeggio + lead, and a punchy kick/snare/hi-hat kit.
//
// Activity-adaptive: game code calls `music.pulse()` on player actions
// (Animations.js wires this). A rolling 4s window converts the pulse
// rate to a 0..1 intensity which scales the louder layers — fast play
// brightens the mix and adds the lead motif on top.
//
// No external assets. Mute/volume persist via localStorage; both the
// topbar 🔊 popover and the dedicated `Music` slider drive them.

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

	var BPM = 128;
	var BEAT_S = 60 / BPM;            // 0.469s — driving but not frantic
	var BAR_BEATS = 4;
	var BAR_DUR = BEAT_S * BAR_BEATS; // 1.875s
	var LOOKAHEAD_S = 1.0;
	var ACTIVITY_WINDOW_MS = 4000;
	var ACTIVITY_FULL_RATE = 3;

	// Am - F - C - G ("axis of awesome") in A minor. Each bar exposes:
	// * bassRoot — pulse-wave bass root frequency
	// * arp — 4-note arpeggio pattern looped through the bar
	// * scale — chord-locked pentatonic SFX can sample for harmonized
	//           clicks/blips that "play along" with the loop
	var BARS = [
		{ // Am
			bassRoot: 110.00,
			arp:   [220.00, 261.63, 329.63, 440.00],   // A C E A
			scale: [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25] // A minor pentatonic + 7th
		},
		{ // F
			bassRoot:  87.31,
			arp:   [174.61, 220.00, 261.63, 349.23],   // F A C F
			scale: [174.61, 220.00, 261.63, 293.66, 349.23, 440.00, 523.25] // F major pentatonic-ish
		},
		{ // C
			bassRoot: 130.81,
			arp:   [261.63, 329.63, 392.00, 523.25],   // C E G C
			scale: [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 659.25] // C major pentatonic
		},
		{ // G
			bassRoot:  98.00,
			arp:   [196.00, 246.94, 293.66, 392.00],   // G B D G
			scale: [196.00, 246.94, 293.66, 369.99, 440.00, 493.88, 587.33] // G mixolydian-ish
		}
	];

	function ensure() {
		if (ctx) return ctx;
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = muted ? 0 : volume;
		masterLP = ctx.createBiquadFilter();
		masterLP.type = "lowpass";
		masterLP.frequency.value = 3500;
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

	// Pulse-wave bass — square with a quick filter envelope for that
	// "doof" attack. Each hit is short so 16th-notes pump cleanly.
	function pulseBass(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "square";
		osc.frequency.value = freq;
		var filt = ctx.createBiquadFilter();
		filt.type = "lowpass";
		filt.frequency.setValueAtTime(900, t);
		filt.frequency.exponentialRampToValueAtTime(280, t + dur * 0.7);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.003);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(filt); filt.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	// Triangle-wave arpeggio — fast notes, very short. NES classic.
	function triangleArp(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "triangle";
		osc.frequency.value = freq;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.002);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	function kick(t, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(160, t);
		osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.004);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + 0.2);
	}

	function snare(t, gain) {
		var dur = 0.14;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 1.5);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var bp = ctx.createBiquadFilter();
		bp.type = "bandpass"; bp.frequency.value = 2000; bp.Q.value = 0.8;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.003);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		src.connect(bp); bp.connect(g); g.connect(master);
		src.start(t);
	}

	function hihat(t, gain) {
		var dur = 0.04;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 3);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var hp = ctx.createBiquadFilter();
		hp.type = "highpass"; hp.frequency.value = 7500;
		var g = ctx.createGain(); g.gain.value = gain;
		src.connect(hp); hp.connect(g); g.connect(master);
		src.start(t);
	}

	function scheduleBar(t) {
		var bar = BARS[barIdx];
		var intens = intensity();

		if (masterLP) {
			masterLP.frequency.linearRampToValueAtTime(2800 + 3500 * intens, t + BAR_DUR);
		}

		// 16th-note pulse-wave bass on the root. The accent on the
		// downbeats gives the "boom-pop-boom-pop" pump.
		var bassGain = 0.18 + 0.06 * intens;
		var sixteenth = BEAT_S * 0.25;
		for (var s = 0; s < 16; s++) {
			var accent = (s % 4 === 0) ? 1.0 : (s % 2 === 0 ? 0.55 : 0.4);
			pulseBass(bar.bassRoot, t + s * sixteenth, sixteenth * 0.85, bassGain * accent);
		}

		// Triangle arpeggio — 8 sixteenths per bar (every other 16th),
		// climbing through the chord tones. Always on.
		var arpGain = 0.07 + 0.04 * intens;
		for (var a = 0; a < 8; a++) {
			var note = bar.arp[a % bar.arp.length];
			// Octave-up jumps on alternate hits for sparkle when intense.
			if (intens > 0.55 && a % 2 === 1) note *= 2;
			triangleArp(note, t + a * sixteenth * 2, sixteenth * 1.6, arpGain);
		}

		// Drums — 4-on-the-floor kick, snare back-beat, hi-hat 8ths.
		var kickGain = 0.20 + 0.08 * intens;
		for (var b = 0; b < BAR_BEATS; b++) kick(t + b * BEAT_S, kickGain);
		var snareGain = 0.07 + 0.08 * intens;
		snare(t + 1 * BEAT_S, snareGain);
		snare(t + 3 * BEAT_S, snareGain);
		var hatGain = 0.015 + 0.020 * intens;
		for (var h = 0; h < 8; h++) {
			hihat(t + h * BEAT_S * 0.5, hatGain * (h % 2 === 1 ? 1.2 : 0.7));
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

	// Music is only audible when (a) the AudioContext is unlocked (user
	// has interacted with the page) AND (b) wantPlaying is true (we're
	// on an in-game view). The router toggles wantPlaying; the first
	// user gesture unlocks and starts immediately if wanted.
	var wantPlaying = false;

	function actuallyStart() {
		if (!ctx || ctx.state === "suspended") return;
		if (started) return;
		started = true;
		nextBarTime = ctx.currentTime + 0.25;
		scheduleAhead();
		schedulerHandle = setInterval(scheduleAhead, 400);
	}

	function unlock() {
		ensure();
		if (!ctx) return;
		if (ctx.state === "suspended") ctx.resume().then(function() {
			if (wantPlaying) actuallyStart();
		});
		else if (wantPlaying) actuallyStart();
	}

	function resume() {
		wantPlaying = true;
		actuallyStart();
	}
	function pause() {
		wantPlaying = false;
		if (schedulerHandle) { clearInterval(schedulerHandle); schedulerHandle = null; }
		started = false;
	}
	// Backwards-compat alias used by the original audio-unlock wiring.
	function start() { unlock(); resume(); }

	// The current audible chord (used by SFX to harmonize). barIdx points
	// to the NEXT bar we'll schedule, so the live one is one behind.
	function currentChord() {
		var liveIdx = (barIdx - 1 + BARS.length) % BARS.length;
		return BARS[liveIdx];
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
		unlock: unlock,
		pause: pause,
		resume: resume,
		pulse: pulse,
		intensity: intensity,
		currentChord: currentChord,
		setMuted: setMuted,
		isMuted: function() { return muted; },
		setVolume: setVolume,
		getVolume: function() { return volume; }
	};
})();
