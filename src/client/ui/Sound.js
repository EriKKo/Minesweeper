// Sound effects (Web Audio API). MSBattle plays terse blips for cascades,
// flags, mine hits, win/lose, etc. — events can fire hundreds of times per
// game so every clip is brief and low-gain. Mute + volume persist to
// localStorage; the AudioContext stays suspended until the first user gesture
// (the click/keydown unlock listeners below).

var sound = (function() {
	var ctx = null, master = null;
	var muted = localStorage.getItem("ms_muted") === "1";
	var volume = parseFloat(localStorage.getItem("ms_volume"));
	if (isNaN(volume)) volume = 0.6;

	function ensure() {
		if (ctx) return ctx;
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) return null;
		ctx = new AC();
		master = ctx.createGain();
		master.gain.value = volume;
		master.connect(ctx.destination);
		return ctx;
	}

	function tone(opts) {
		if (muted || !ensure()) return;
		if (ctx.state === "suspended") ctx.resume();
		var t0 = ctx.currentTime + (opts.delay || 0);
		var osc = ctx.createOscillator();
		var g = ctx.createGain();
		osc.type = opts.type || "sine";
		osc.frequency.setValueAtTime(opts.freq, t0);
		if (opts.toFreq) osc.frequency.exponentialRampToValueAtTime(opts.toFreq, t0 + opts.dur);
		var peak = opts.gain != null ? opts.gain : 0.2;
		g.gain.setValueAtTime(0.0001, t0);
		g.gain.exponentialRampToValueAtTime(peak, t0 + 0.005);
		g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
		osc.connect(g); g.connect(master);
		osc.start(t0); osc.stop(t0 + opts.dur + 0.02);
	}

	function noise(opts) {
		if (muted || !ensure()) return;
		if (ctx.state === "suspended") ctx.resume();
		var t0 = ctx.currentTime;
		var dur = opts.dur || 0.3;
		var buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
		var data = buf.getChannelData(0);
		for (var i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
		var src = ctx.createBufferSource(); src.buffer = buf;
		var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = opts.cutoff || 800;
		var g = ctx.createGain(); g.gain.value = opts.gain != null ? opts.gain : 0.4;
		src.connect(lp); lp.connect(g); g.connect(master);
		src.start(t0);
	}

	function arp(freqs, step, dur, gain) {
		for (var i = 0; i < freqs.length; i++) tone({ type: "triangle", freq: freqs[i], dur: dur, gain: gain, delay: i * step });
	}

	// SFX that scale up with how fast the player is going. We read the
	// live music chord + intensity and step through a small ladder of
	// timbres so the soundscape progressively "thickens" as activity
	// climbs:
	//   level 0 (idle, no music): generic ascending triangle clicks
	//   level 1 (intensity < 0.5):  chord-scale climb, triangle
	//   level 2 (intensity < 0.8):  chord-scale climb, square (brighter)
	//   level 3 (intensity ≥ 0.8):  square + sub-octave triangle layer
	function liveMusic() {
		if (typeof music === "undefined" || music.isMuted()) return null;
		var chord = music.currentChord && music.currentChord();
		if (!chord) return null;
		return { chord: chord, intensity: music.intensity ? music.intensity() : 0 };
	}

	return {
		cascade: function(n) {
			var ticks = Math.max(1, Math.min(n, 7));
			var live = liveMusic();
			for (var i = 0; i < ticks; i++) {
				var delay = i * 0.028;
				if (!live || live.intensity < 0.15) {
					tone({ type: "triangle", freq: 560 + i * 70, dur: 0.045, gain: 0.05, delay: delay });
					continue;
				}
				var scale = live.chord.scale;
				var note = scale[i % scale.length];
				if (i >= scale.length) note *= 2;
				if (live.intensity < 0.5) {
					tone({ type: "triangle", freq: note, dur: 0.05, gain: 0.055, delay: delay });
				} else if (live.intensity < 0.8) {
					tone({ type: "square", freq: note, dur: 0.05, gain: 0.06, delay: delay });
				} else {
					tone({ type: "square", freq: note, dur: 0.055, gain: 0.07, delay: delay });
					tone({ type: "triangle", freq: note / 2, dur: 0.07, gain: 0.04, delay: delay });
				}
			}
		},
		opponentDone: function(n) {
			var base = 720 + Math.min(n, 4) * 70;
			tone({ type: "triangle", freq: base, dur: 0.09, gain: 0.06 });
			tone({ type: "triangle", freq: base * 1.34, dur: 0.12, gain: 0.06, delay: 0.085 });
		},
		flag: function() {
			var live = liveMusic();
			if (live && live.intensity > 0.15) {
				// Flag = a punchy chord-root hit so it harmonizes with the loop.
				var f = live.chord.bassRoot * 2;
				tone({ type: "square", freq: f, toFreq: f * 0.75, dur: 0.08, gain: 0.07 });
				if (live.intensity > 0.6) noise({ dur: 0.05, cutoff: 3500, gain: 0.05 });
			} else {
				tone({ type: "square", freq: 420, toFreq: 300, dur: 0.06, gain: 0.06 });
			}
		},
		unflag: function() {
			var live = liveMusic();
			if (live && live.intensity > 0.15) {
				tone({ type: "square", freq: live.chord.bassRoot * 1.5, dur: 0.04, gain: 0.05 });
			} else {
				tone({ type: "square", freq: 300, dur: 0.04, gain: 0.04 });
			}
		},
		mine: function() {
			noise({ dur: 0.35, cutoff: 500, gain: 0.5 });
			tone({ type: "sine", freq: 150, toFreq: 50, dur: 0.4, gain: 0.22 });
		},
		beep: function(freq) { tone({ type: "sine", freq: freq, dur: 0.12, gain: 0.12 }); },
		// The idle→ready board sweep (BOARD_GO_STYLE, Animations.js) — a rising tone timed to the
		// sweep's own duration so the pitch climb tracks the wave crossing the board, plus a soft
		// filtered-noise layer underneath for a bit of "whoosh" texture. Reads durationMs live
		// rather than hardcoding 700ms so retuning the sweep's speed (from /admin/countdown) keeps
		// the sound in sync without a second place to edit. This is a different moment from go()
		// below — go() is the "GO!" cue when the round actually goes live, at the END of the
		// countdown; this fires immediately when the sweep itself starts, well before that.
		sweep: function() {
			var dur = (typeof BOARD_GO_STYLE !== "undefined" && BOARD_GO_STYLE.durationMs) ? BOARD_GO_STYLE.durationMs / 1000 : 0.7;
			tone({ type: "sine", freq: 260, toFreq: 720, dur: dur, gain: 0.09 });
			noise({ dur: dur, cutoff: 2200, gain: 0.05 });
		},
		go: function() { tone({ type: "sine", freq: 880, dur: 0.25, gain: 0.16 }); },
		win: function() { arp([523, 659, 784, 1047], 0.09, 0.28, 0.12); },
		lose: function() { tone({ type: "sine", freq: 320, toFreq: 200, dur: 0.32, gain: 0.11 }); },
		seriesWin: function() { arp([523, 659, 784, 1047, 1319], 0.11, 0.34, 0.13); },
		// Triumphant rising fanfare when you climb a tier; a soft descending sigh when you drop one.
		rankUp: function() { arp([659, 880, 1047, 1319, 1568], 0.10, 0.38, 0.14); },
		rankDown: function() { tone({ type: "sine", freq: 440, toFreq: 233, dur: 0.42, gain: 0.12 }); },
		// Crisp two-note "you're in" cue when a ranked match forms.
		matchFound: function() { arp([587, 880], 0.09, 0.22, 0.13); },
		unlock: function() { if (ensure() && ctx.state === "suspended") ctx.resume(); },
		setMuted: function(m) { muted = m; localStorage.setItem("ms_muted", m ? "1" : "0"); },
		isMuted: function() { return muted; },
		setVolume: function(v) { volume = v; localStorage.setItem("ms_volume", String(v)); if (master) master.gain.value = v; },
		getVolume: function() { return volume; }
	};
})();

function unlockAudio() {
	sound.unlock();
	// Just unlock the music's AudioContext on first gesture; whether
	// it actually starts playing is controlled by the router (only on
	// in-game views) and the per-mode start_game / series_ended hooks.
	if (typeof music !== "undefined") music.unlock();
}
document.addEventListener("click", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
