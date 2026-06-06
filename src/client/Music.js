// Procedural smooth-jazz soundtrack for MSBattle, generated live by the
// Web Audio API. ii-V-I-vi turnaround in C major (Dm7 - G7 - Cmaj7 -
// A7) at ~92 BPM with swing eighth-notes. Walking bass and brushed
// percussion always play; FM-Rhodes comping stabs and a melodic lead
// layer in as the player gets active.
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

	var BPM = 92;
	var BEAT_S = 60 / BPM;            // 0.652s — strolling tempo
	var BAR_BEATS = 4;
	var BAR_DUR = BEAT_S * BAR_BEATS; // 2.61s
	// Swing ratio for 8th notes: first 8th gets ~66% of the beat (triplet
	// feel), second 8th gets the remaining ~34%. The classic jazz lilt.
	var SWING_OFFSET = BEAT_S * 0.66;
	var LOOKAHEAD_S = 1.2;
	var ACTIVITY_WINDOW_MS = 4000;
	var ACTIVITY_FULL_RATE = 3;

	// ii-V-I-vi turnaround in C. Each bar carries: a 4-note walking-bass
	// line through chord tones, a rootless mid-range voicing for the
	// Rhodes comp, and the chord-scale degrees the melody can pick from.
	var BARS = [
		{ // Dm7
			walk:    [146.83, 174.61, 220.00, 261.63],   // D - F - A - C
			voicing: [261.63, 349.23, 440.00, 523.25],   // C E A C (rootless Dm9-ish)
			scale:   [293.66, 329.63, 349.23, 392.00, 440.00, 523.25, 587.33] // D dorian
		},
		{ // G7
			walk:    [196.00, 246.94, 293.66, 174.61],   // G - B - D - F
			voicing: [246.94, 293.66, 349.23, 493.88],   // B D F B
			scale:   [293.66, 329.63, 369.99, 392.00, 440.00, 493.88, 587.33] // G mixolydian
		},
		{ // Cmaj7
			walk:    [130.81, 164.81, 196.00, 220.00],   // C - E - G - A
			voicing: [246.94, 329.63, 392.00, 493.88],   // B E G B
			scale:   [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88] // C major
		},
		{ // A7
			walk:    [110.00, 138.59, 164.81, 196.00],   // A - C# - E - G
			voicing: [277.18, 329.63, 391.99, 523.25],   // C# E G C (rootless A13)
			scale:   [293.66, 329.63, 369.99, 415.30, 440.00, 523.25, 587.33] // A mixolydian-ish
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
		masterLP.frequency.value = 3000;
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

	// Upright-bass-ish pluck: triangle + low-pass + soft attack + decay.
	function walkBass(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "triangle";
		osc.frequency.value = freq;
		var filt = ctx.createBiquadFilter();
		filt.type = "lowpass";
		filt.frequency.value = 380;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.02);
		g.gain.linearRampToValueAtTime(gain * 0.45, t + dur * 0.4);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(filt); filt.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
	}

	// Rhodes-style electric piano via FM synthesis. The modulator at the
	// carrier's frequency gives that bell-like bite; the modulation index
	// drops fast for the soft body underneath.
	function rhodesNote(freq, t, dur, gain) {
		var carrier = ctx.createOscillator();
		var modulator = ctx.createOscillator();
		var modGain = ctx.createGain();
		carrier.type = "sine";
		modulator.type = "sine";
		carrier.frequency.value = freq;
		modulator.frequency.value = freq;
		// FM depth: sharp at attack, fades through note for that pluck.
		modGain.gain.setValueAtTime(freq * 3.5, t);
		modGain.gain.exponentialRampToValueAtTime(freq * 0.2, t + 0.18);
		modulator.connect(modGain);
		modGain.connect(carrier.frequency);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		carrier.connect(g); g.connect(master);
		carrier.start(t); carrier.stop(t + dur + 0.02);
		modulator.start(t); modulator.stop(t + dur + 0.02);
	}

	function rhodesStab(freqs, t, dur, gain) {
		// Slight stagger gives the comp a more played-by-hand feel.
		for (var i = 0; i < freqs.length; i++) {
			rhodesNote(freqs[i], t + i * 0.004, dur, gain);
		}
	}

	// Brushed snare/cymbal — filtered noise with a soft envelope.
	function brush(t, dur, gain, lowpass) {
		var samples = Math.floor(ctx.sampleRate * dur);
		var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < samples; i++) {
			data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 1.3);
		}
		var src = ctx.createBufferSource(); src.buffer = buf;
		var lp = ctx.createBiquadFilter();
		lp.type = "lowpass"; lp.frequency.value = lowpass || 6000;
		var hp = ctx.createBiquadFilter();
		hp.type = "highpass"; hp.frequency.value = 1200;
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.01);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(master);
		src.start(t);
	}

	function leadNote(freq, t, dur, gain) {
		var osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.value = freq;
		// Light vibrato for a more "blown" or "sung" feel.
		var vib = ctx.createOscillator();
		var vibGain = ctx.createGain();
		vib.frequency.value = 5.5;
		vibGain.gain.value = freq * 0.008;
		vib.connect(vibGain); vibGain.connect(osc.frequency);
		var g = ctx.createGain();
		g.gain.setValueAtTime(0.0001, t);
		g.gain.linearRampToValueAtTime(gain, t + 0.04);
		g.gain.linearRampToValueAtTime(gain * 0.7, t + dur * 0.6);
		g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
		osc.connect(g); g.connect(master);
		osc.start(t); osc.stop(t + dur + 0.02);
		vib.start(t); vib.stop(t + dur + 0.02);
	}

	// Swing-aware time for the i-th 8th note from a beat start (0 = down,
	// 1 = "and" with swing).
	function swing8(beatStart, eighthIdx) {
		return beatStart + (eighthIdx === 0 ? 0 : SWING_OFFSET);
	}

	function pickMelodyPhrase(scale, prev) {
		// 4 quarter-note positions, but each can carry a swung 8th-note
		// pair when intensity is high. Pick mostly stepwise motion from
		// the previous note for a singable line.
		var phrase = [];
		var idx = prev != null ? prev : Math.floor(scale.length / 2);
		for (var i = 0; i < 4; i++) {
			var step = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
			idx = Math.max(0, Math.min(scale.length - 1, idx + step));
			phrase.push({ note: scale[idx], scaleIdx: idx });
		}
		return phrase;
	}

	var lastMelodyIdx = null;

	function scheduleBar(t) {
		var bar = BARS[barIdx];
		var intens = intensity();

		if (masterLP) {
			masterLP.frequency.linearRampToValueAtTime(2800 + 3000 * intens, t + BAR_DUR);
		}

		// Walking bass — quarter notes through chord tones every bar.
		var bassGain = 0.18 + 0.04 * intens;
		for (var b = 0; b < BAR_BEATS; b++) {
			walkBass(bar.walk[b], t + b * BEAT_S, BEAT_S * 0.92, bassGain);
		}

		// Brushes — soft "tss" on every beat, slightly accented on 2 and 4
		// for a relaxed jazz drum feel. Always present.
		for (var br = 0; br < BAR_BEATS; br++) {
			var accent = (br === 1 || br === 3) ? 1 : 0.6;
			brush(t + br * BEAT_S, 0.18, 0.025 * accent + 0.012 * intens, 7000);
		}

		// Comping stabs — Rhodes voicing on the "and of 2" and "and of 4"
		// with swing. Always present, slightly louder with intensity.
		var compGain = 0.07 + 0.05 * intens;
		rhodesStab(bar.voicing, swing8(t + 1 * BEAT_S, 1), 0.45, compGain);
		rhodesStab(bar.voicing, swing8(t + 3 * BEAT_S, 1), 0.45, compGain);

		// Soft ghost notes / shaker pattern on the swung 8ths past 0.25
		// intensity — fills the rhythmic gaps so the groove pushes forward.
		if (intens > 0.25) {
			var ghostGain = 0.005 + 0.012 * (intens - 0.25);
			for (var bb = 0; bb < BAR_BEATS; bb++) {
				brush(swing8(t + bb * BEAT_S, 1), 0.07, ghostGain, 4500);
			}
		}

		// Melodic lead — joins past intensity 0.35. Quarter notes following
		// the chord scale, with stepwise motion from the previous phrase.
		if (intens > 0.35) {
			var leadGain = 0.06 + 0.06 * (intens - 0.35);
			var phrase = pickMelodyPhrase(bar.scale, lastMelodyIdx);
			for (var n = 0; n < 4; n++) {
				leadNote(phrase[n].note, t + n * BEAT_S, BEAT_S * 0.9, leadGain);
				// At high intensity, sprinkle a passing 8th on some beats.
				if (intens > 0.7 && Math.random() < 0.4) {
					var passingIdx = Math.max(0, Math.min(bar.scale.length - 1, phrase[n].scaleIdx + 1));
					leadNote(bar.scale[passingIdx], swing8(t + n * BEAT_S, 1), BEAT_S * 0.35, leadGain * 0.7);
				}
			}
			lastMelodyIdx = phrase[3].scaleIdx;
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
		nextBarTime = ctx.currentTime + 0.3;
		scheduleAhead();
		schedulerHandle = setInterval(scheduleAhead, 500);
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
