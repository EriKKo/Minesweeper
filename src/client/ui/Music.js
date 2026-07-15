// Procedural chiptune-style soundtrack for MSBattle, generated live by
// the Web Audio API. Inspired by "bassloom — pixel pulse": 128 BPM in
// A minor with an Am-Em-F-C progression, a growling sub-layered bass on a
// syncopated pattern, triangle-wave arpeggio + lead, and an electro
// kick/clap/hi-hat kit on a breakbeat pattern. (Picked via the Battle
// theme lab at /admin/sounds, which can audition every alternative this
// shipped combo was chosen from.)
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

	// Am - Em - F - C in A minor. Each bar exposes:
	// * bassRoot — bass root frequency
	// * arp — 4-note arpeggio pattern looped through the bar
	// * scale — chord-locked pentatonic SFX can sample for harmonized
	//           clicks/blips that "play along" with the loop
	var BARS = [
		{ // Am
			bassRoot: 110.00,
			arp:   [220.00, 261.63, 329.63, 440.00],   // A C E A
			scale: [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25] // A minor pentatonic + 7th
		},
		{ // Em
			bassRoot:  82.41,
			arp:   [164.81, 196.00, 246.94, 329.63],   // E G B E
			scale: [164.81, 196.00, 220.00, 246.94, 293.66, 329.63, 392.00] // E minor pentatonic + 7th
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
	// "doof" attack. No longer the shipped voice (see subGrowlBass below),
	// kept as a real synth so the Sound Lab's "Pulse" option is exact code,
	// not a reimplementation.
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

	// Sub Growl bass — the shipped voice: a filtered square layered with a
	// sine an octave down, for more low-end weight than the plain pulse.
	function subGrowlBass(freq, t, dur, gain) {
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

	// The "Classic" kit — no longer shipped (see the electro* kit below), kept as real synths so
	// the Sound Lab's "Classic" kit option is exact code, not a reimplementation.
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

	// The "Electro" kit — the shipped kit: a booming 808-style kick, a layered clap instead of a
	// snare, and a crisp metallic hi-hat.
	function electroKick(t, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(150, t);
		osc.frequency.exponentialRampToValueAtTime(30, t + 0.3);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.004);
		g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + 0.44);
	}
	// A clap: three quick overlapping noise bursts instead of one.
	function electroSnare(t, gain) {
		[0, 0.012, 0.024].forEach(function(off) {
			var dur = 0.09;
			var samples = Math.floor(ctx.sampleRate * dur);
			var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
			var data = buf.getChannelData(0);
			for (var i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 2);
			var src = ctx.createBufferSource(); src.buffer = buf;
			var bp = ctx.createBiquadFilter();
			bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 1.4;
			var g = ctx.createGain();
			var t0 = t + off;
			g.gain.setValueAtTime(0.0001, t0);
			g.gain.linearRampToValueAtTime(gain * 0.7, t0 + 0.002);
			g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
			src.connect(bp); bp.connect(g); g.connect(master);
			src.start(t0);
		});
	}
	function electroHihat(t, gain) {
		var dur = 0.03;
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 4);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var hp = ctx.createBiquadFilter();
		hp.type = "highpass"; hp.frequency.value = 9500;
		var g = ctx.createGain(); g.gain.value = gain * 1.3;
		src.connect(hp); hp.connect(g); g.connect(master);
		src.start(t);
	}

	// Syncopated bass hits: 6 per bar, pushed off the beat instead of an even 16th-note grid — in
	// beats (of BEAT_S), with a relative gain accent per hit. Mirrored exactly in the Sound Lab's
	// "Syncopated" bass rhythm (SoundLab.js) so that option previews the real pattern.
	var BASS_SYNCOPATED_HITS = [
		{ at: 0,    dur: 0.9, g: 1.0 },
		{ at: 0.75, dur: 0.4, g: 0.6 },
		{ at: 1.5,  dur: 0.4, g: 0.85 },
		{ at: 2.25, dur: 0.4, g: 0.55 },
		{ at: 3,    dur: 0.9, g: 0.9 },
		{ at: 3.75, dur: 0.4, g: 0.5 }
	];
	// Breakbeat drum hits, in beats: kick pushes ahead of 2 and 4, snare/clap holds the backbeat,
	// hi-hat runs steady 16ths underneath. Mirrored exactly in the Sound Lab's "Breakbeat"
	// percussion pattern (SoundLab.js) so that option previews the real pattern.
	var DRUM_KICK_BEATS = [0, 1.5, 2.75];
	var DRUM_SNARE_BEATS = [1, 3];

	function scheduleBar(t) {
		var bar = BARS[barIdx];
		var intens = intensity();

		if (masterLP) {
			masterLP.frequency.linearRampToValueAtTime(2800 + 3500 * intens, t + BAR_DUR);
		}

		// Syncopated sub-growl bass on the root — pushed off the beat instead of a straight
		// 16th-note grid, for more of a groove than a pump.
		var bassGain = 0.18 + 0.06 * intens;
		BASS_SYNCOPATED_HITS.forEach(function(h) {
			subGrowlBass(bar.bassRoot, t + h.at * BEAT_S, h.dur * BEAT_S, bassGain * h.g);
		});

		// Triangle arpeggio — 8 sixteenths per bar (every other 16th),
		// climbing through the chord tones. Always on.
		var arpGain = 0.07 + 0.04 * intens;
		var sixteenth = BEAT_S * 0.25;
		for (var a = 0; a < 8; a++) {
			var note = bar.arp[a % bar.arp.length];
			// Octave-up jumps on alternate hits for sparkle when intense.
			if (intens > 0.55 && a % 2 === 1) note *= 2;
			triangleArp(note, t + a * sixteenth * 2, sixteenth * 1.6, arpGain);
		}

		// Electro drums on a breakbeat pattern — kick pushes ahead of the backbeat, a layered
		// clap instead of a plain snare, steady 16th hi-hats.
		var kickGain = 0.20 + 0.08 * intens;
		DRUM_KICK_BEATS.forEach(function(b) { electroKick(t + b * BEAT_S, kickGain); });
		var snareGain = 0.07 + 0.08 * intens;
		DRUM_SNARE_BEATS.forEach(function(b) { electroSnare(t + b * BEAT_S, snareGain); });
		var hatGain = 0.015 + 0.020 * intens;
		for (var h = 0; h < 16; h++) {
			electroHihat(t + h * sixteenth, hatGain * (h % 4 === 0 ? 1.1 : 0.7));
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
		getVolume: function() { return volume; },
		// Sound Lab only (/admin/sounds) — never called from real gameplay code. Exposes the bar
		// progression + timing constants and every real synth (bass/melody/percussion, shipped and
		// retired alike) so each Battle theme lab option is the exact function, not a copy, plus the
		// shared AudioContext/master gain so a lab preview plays through the same graph rather than
		// duplicating it. getCtx() calls ensure() same as any real playback path, so it lazily
		// creates the context if needed.
		lab: {
			BARS: BARS,
			BEAT_S: BEAT_S,
			BAR_DUR: BAR_DUR,
			pulseBass: pulseBass,
			subGrowlBass: subGrowlBass,
			triangleArp: triangleArp,
			kick: kick,
			snare: snare,
			hihat: hihat,
			electroKick: electroKick,
			electroSnare: electroSnare,
			electroHihat: electroHihat,
			getCtx: function() { return ensure(); },
			getMaster: function() { return master; }
		}
	};
})();
