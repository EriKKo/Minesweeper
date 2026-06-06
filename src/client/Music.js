// Procedural ambient music for MSBattle. A slow chord progression with
// soft sine/triangle pads — meant to sit under everything without
// competing with the SFX in Sound.js. No external assets; generated
// live by the Web Audio API.
//
// Mute state piggybacks on the existing `ms_muted` flag so the topbar
// 🔊/🔇 button controls both SFX and music together. Browsers block
// autoplay until the first user gesture, so `start()` is wired into
// the same click/keydown unlock as the rest of the audio.

var music = (function() {
	var ctx = null, master = null;
	var muted = localStorage.getItem("ms_muted") === "1";
	var volume = parseFloat(localStorage.getItem("ms_music_volume"));
	if (isNaN(volume)) volume = 0.18; // sit well below SFX
	var started = false;
	var nextChordTime = 0;
	var chordIdx = 0;
	var schedulerHandle = null;

	// I-vi-IV-V in C major, voiced as seventh chords for a calm, jazzy feel.
	// Pitches are in Hz (rounded equal-tempered). Each entry is the chord's
	// {root, third, fifth, seventh} from low to high.
	var CHORDS = [
		[130.81, 164.81, 196.00, 246.94], // Cmaj7 (C E G B), root C3
		[110.00, 130.81, 164.81, 196.00], // Am7   (A C E G), root A2
		[ 87.31, 110.00, 130.81, 164.81], // Fmaj7 (F A C E), root F2
		[ 98.00, 123.47, 146.83, 174.61]  // G7    (G B D F), root G2
	];
	// Melody pool drawn from the C major scale (one octave above root).
	var MELODY_HZ = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25];
	var CHORD_DUR = 6.0;             // seconds per chord
	var LOOKAHEAD_S = 1.5;           // schedule this far ahead
	var MELODY_PROB = 0.55;          // chance of a melody note per chord

	function ensure() {
		if (ctx) return ctx;
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = muted ? 0 : volume;
		// Gentle low-pass keeps the upper harmonics from being harsh.
		var lp = ctx.createBiquadFilter();
		lp.type = "lowpass";
		lp.frequency.value = 2200;
		master.connect(lp);
		lp.connect(ctx.destination);
		return ctx;
	}

	function envelopedOsc(type, freq, startTime, dur, attack, release, gain) {
		var osc = ctx.createOscillator();
		osc.type = type;
		osc.frequency.value = freq;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0, startTime);
		g.gain.linearRampToValueAtTime(gain, startTime + attack);
		g.gain.setValueAtTime(gain, startTime + dur - release);
		g.gain.linearRampToValueAtTime(0, startTime + dur);
		osc.connect(g);
		g.connect(master);
		osc.start(startTime);
		osc.stop(startTime + dur + 0.05);
	}

	function playChord(freqs, startTime) {
		// Voices overlap a touch with the next chord for a smooth transition.
		var dur = CHORD_DUR + 1.6;
		// Bass + tenor pad: triangle on the root, sine on the upper voices.
		envelopedOsc("triangle", freqs[0] * 0.5, startTime, dur, 1.5, 1.8, 0.18);
		envelopedOsc("sine",     freqs[1],       startTime, dur, 1.2, 1.6, 0.10);
		envelopedOsc("sine",     freqs[2],       startTime, dur, 1.0, 1.4, 0.09);
		envelopedOsc("sine",     freqs[3],       startTime, dur, 1.0, 1.4, 0.07);
		// Occasional sparkly melody note in the second half of the chord.
		if (Math.random() < MELODY_PROB) {
			var note = MELODY_HZ[Math.floor(Math.random() * MELODY_HZ.length)];
			var delay = CHORD_DUR * (0.35 + Math.random() * 0.4);
			envelopedOsc("triangle", note, startTime + delay, 1.6, 0.05, 1.3, 0.06);
		}
	}

	function scheduleAhead() {
		if (!ctx) return;
		while (nextChordTime < ctx.currentTime + LOOKAHEAD_S) {
			playChord(CHORDS[chordIdx], nextChordTime);
			chordIdx = (chordIdx + 1) % CHORDS.length;
			nextChordTime += CHORD_DUR;
		}
	}

	function start() {
		ensure();
		if (!ctx) return;
		if (ctx.state === "suspended") ctx.resume();
		if (started) return;
		started = true;
		nextChordTime = ctx.currentTime + 0.4;
		scheduleAhead();
		schedulerHandle = setInterval(scheduleAhead, 1000);
	}

	function setMuted(m) {
		muted = m;
		localStorage.setItem("ms_muted", m ? "1" : "0");
		if (master) master.gain.linearRampToValueAtTime(m ? 0 : volume, (ctx ? ctx.currentTime : 0) + 0.2);
	}
	function setVolume(v) {
		volume = v;
		localStorage.setItem("ms_music_volume", String(v));
		if (master && !muted) master.gain.linearRampToValueAtTime(v, (ctx ? ctx.currentTime : 0) + 0.2);
	}

	return {
		start: start,
		setMuted: setMuted,
		isMuted: function() { return muted; },
		setVolume: setVolume,
		getVolume: function() { return volume; }
	};
})();
