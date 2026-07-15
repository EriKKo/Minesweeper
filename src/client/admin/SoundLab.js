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

// ---- battle theme lab: bass / melody / percussion, each independently switchable, playable
// together over a shared chord progression -------------------------------------------------------
// Three layers, each with its own timbre-ish axis (voice/kit) and rhythm-ish axis (pattern), plus
// an on/off toggle so any subset can play — "just the drums", "bass and melody, no drums", or
// everything at once. All three read the same progression pick, so bass root and melody arpeggio
// always stay harmonized. Every picker is a segmented control (.cr-seg, same widget
// CountdownLab.js's style pickers use); the one Play/Stop button combines whichever options are
// currently selected, and changing anything — including a layer's on/off toggle — mid-loop takes
// effect on the NEXT bar rather than requiring a restart, same "live" feel as the Playback speed
// slider above.
var BASS_PREVIEW_GAIN = 0.24;
var MELODY_PREVIEW_GAIN = 0.09;

// -- timbres: per-note synthesis, signature (ctx, master, freq, t, dur, gain) — same shape for
// every one so any timbre can drive any rhythm below without special-casing.

// music.lab.pulseBass/subGrowlBass's real signature is (freq, t, dur, gain) — each reaches its
// own ctx/master via Music.js's closure, unlike the shared (ctx, master, freq, t, dur, gain)
// shape here. These adapt them rather than special-casing the caller, so each is a drop-in like
// every other timbre.
function playPulseBass(ctx, master, freq, t, dur, gain) {
	music.lab.pulseBass(freq, t, dur, gain);
}
function playSubGrowlBass(ctx, master, freq, t, dur, gain) {
	music.lab.subGrowlBass(freq, t, dur, gain);
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
	{ id: "subgrowl", label: "Sub Growl", desc: "A square pulse layered with a sine an octave down — the shipped bass's own voice.", synth: playSubGrowlBass },
	{ id: "pulse", label: "Pulse", desc: "The plain square pulse Sub Growl is built on, without the sub-octave layer — thinner, punchier.", synth: playPulseBass },
	{ id: "saw", label: "Sawtooth Drive", desc: "Sawtooth instead of square, same envelope — brighter, more aggressive.", synth: bassSaw },
	{ id: "wobble", label: "Wobble Filter", desc: "Sawtooth through an LFO-wobbled resonant filter — a dubstep-lite \"wub\".", synth: bassWobbleFilter }
];

// -- rhythms: schedule(synthFn, ctx, master, freq, barStartT, beatS, gain), one call per bar,
// each responsible for calling synthFn as many times as its own pattern needs.

// The shipped bass rhythm — mirrors Music.js's BASS_SYNCOPATED_HITS exactly, so this option
// previews the real pattern rather than a lookalike.
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
	{ id: "syncopated", label: "Syncopated", desc: "Hits push ahead of some beats instead of landing squarely on them — Section A's bass rhythm.", schedule: rhythmSyncopated },
	{ id: "straight16", label: "Straight 16ths", desc: "16 evenly-spaced hits per bar, loud on the downbeats — Section B's bass rhythm, a steadier pump instead of a groove.", schedule: rhythmStraight16 },
	{ id: "fourfloor", label: "Four-on-the-floor", desc: "One sustained note per beat instead of short hits — steadier, more spacious.", schedule: rhythmFourFloor },
	{ id: "octavebounce", label: "Octave Bounce", desc: "16 evenly-spaced hits, alternating root / octave-up — a bouncier, more melodic \"oom-pah\" line.", schedule: rhythmOctaveBounce },
	{ id: "halftime", label: "Half-time 8ths", desc: "8 hits per bar instead of 16 — half the density, a heavier, more deliberate feel.", schedule: rhythmHalfTime }
];

// -- melody: per-note synthesis (ctx, master, freq, t, dur, gain) plus schedule(synthFn, ctx,
// master, arpNotes, t, beatS, gain) rhythms, where arpNotes is the current bar's 4-note chord
// arpeggio (from the progression below) rather than a single root — the melody follows the chord
// shape, the bass just holds its root.

// music.lab.triangleArp's real signature is (freq, t, dur, gain), same closure-ctx/master
// pattern as pulseBass — adapted to the shared (ctx, master, freq, t, dur, gain) shape.
function playTriangleArp(ctx, master, freq, t, dur, gain) {
	music.lab.triangleArp(freq, t, dur, gain);
}
function melodySquare(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "square";
	osc.frequency.value = freq;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 0.8, t + 0.002);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	osc.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + dur + 0.02);
}
// Two sine partials (an octave, and a fifth-plus-octave slightly detuned for shimmer) instead of
// one chip-style oscillator — a chiming, metallic ring rather than a blip.
function melodyBell(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sine";
	osc.frequency.value = freq * 2;
	var osc2 = ctx.createOscillator();
	osc2.type = "sine";
	osc2.frequency.value = freq * 3.01;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + 0.002);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.6);
	var g2 = ctx.createGain();
	g2.gain.setValueAtTime(0.0001, t);
	g2.gain.linearRampToValueAtTime(gain * 0.35, t + 0.002);
	g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.1);
	osc.connect(g); g.connect(master);
	osc2.connect(g2); g2.connect(master);
	osc.start(t); osc.stop(t + dur * 1.6 + 0.02);
	osc2.start(t); osc2.stop(t + dur * 1.1 + 0.02);
}
function melodyPluck(ctx, master, freq, t, dur, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sawtooth";
	osc.frequency.value = freq;
	var filt = ctx.createBiquadFilter();
	filt.type = "lowpass";
	filt.frequency.setValueAtTime(freq * 6, t);
	filt.frequency.exponentialRampToValueAtTime(freq * 1.2, t + dur * 0.8);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + 0.002);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	osc.connect(filt); filt.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + dur + 0.02);
}

var BATTLE_LAB_MELODY_TIMBRES = [
	{ id: "triangle", label: "Triangle", desc: "Fast triangle-wave notes — the shipped arpeggio's own voice, straight NES chiptune.", synth: playTriangleArp },
	{ id: "square", label: "Square", desc: "Buzzier square wave instead of triangle — punchier, more 8-bit.", synth: melodySquare },
	{ id: "bell", label: "Bell", desc: "Two sine partials layered up an octave and a fifth — a chiming, metallic ring instead of a chip blip.", synth: melodyBell },
	{ id: "pluck", label: "Pluck", desc: "Sawtooth through a fast-closing filter — a plucked, pizzicato character.", synth: melodyPluck }
];

function melodyRhythmRunning8ths(synthFn, ctx, master, notes, t, beatS, gain) {
	var sixteenth = beatS * 0.25;
	for (var a = 0; a < 8; a++) {
		synthFn(ctx, master, notes[a % notes.length], t + a * sixteenth * 2, sixteenth * 1.6, gain);
	}
}
function melodyRhythmQuarters(synthFn, ctx, master, notes, t, beatS, gain) {
	for (var b = 0; b < 4; b++) synthFn(ctx, master, notes[b % notes.length], t + b * beatS, beatS * 0.85, gain);
}
function melodyRhythmSixteenths(synthFn, ctx, master, notes, t, beatS, gain) {
	var sixteenth = beatS * 0.25;
	for (var s = 0; s < 16; s++) {
		synthFn(ctx, master, notes[s % notes.length], t + s * sixteenth, sixteenth * 0.8, gain * (s % 4 === 0 ? 1.0 : 0.7));
	}
}
function melodyRhythmSyncopated(synthFn, ctx, master, notes, t, beatS, gain) {
	var hits = [
		{ at: 0,    idx: 0, dur: 0.4 },
		{ at: 0.75, idx: 1, dur: 0.3 },
		{ at: 1.5,  idx: 2, dur: 0.3 },
		{ at: 2.5,  idx: 3, dur: 0.4 },
		{ at: 3.25, idx: 1, dur: 0.3 }
	];
	hits.forEach(function(h) { synthFn(ctx, master, notes[h.idx % notes.length], t + h.at * beatS, h.dur * beatS, gain); });
}

var BATTLE_LAB_MELODY_RHYTHMS = [
	{ id: "running8ths", label: "Running 8ths", desc: "8 notes per bar cycling through the chord tones — Section A's melody rhythm.", schedule: melodyRhythmRunning8ths },
	{ id: "sixteenths", label: "Sixteenth run", desc: "16 notes per bar — a fast, machine-gun arpeggio. Section B's melody rhythm, paired there with a quieter per-note gain so the density reads as \"faster\", not \"louder\".", schedule: melodyRhythmSixteenths },
	{ id: "quarters", label: "Sparse quarters", desc: "One note per beat instead of 8 — a calmer, more spacious line.", schedule: melodyRhythmQuarters },
	{ id: "syncopated", label: "Syncopated", desc: "A handful of notes pushed off the beat instead of an even cycle — more of a riff, less of a scale run.", schedule: melodyRhythmSyncopated }
];

// -- percussion: a "kit" is the 3 instrument voices (kick/snare/hihat), each (ctx, master, t,
// gain); a "pattern" is schedule(kit, ctx, master, t, beatS, gain) where gain is the
// {kick,snare,hat} triple below — kick/snare/hat naturally sit at very different loudnesses, so
// unlike bass/melody a single scalar gain isn't enough.
var PERC_PREVIEW_GAIN = { kick: 0.24, snare: 0.13, hat: 0.03 };

// music.lab.kick/snare/hihat's real signature is (t, gain) — reaching ctx/master via Music.js's
// own closure, same pattern as pulseBass/triangleArp. Adapted to the shared kit shape.
function percKick(ctx, master, t, gain) { music.lab.kick(t, gain); }
function percSnare(ctx, master, t, gain) { music.lab.snare(t, gain); }
function percHihat(ctx, master, t, gain) { music.lab.hihat(t, gain); }

function punchyKick(ctx, master, t, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sine";
	osc.frequency.setValueAtTime(190, t);
	osc.frequency.exponentialRampToValueAtTime(35, t + 0.16);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 1.15, t + 0.003);
	g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
	osc.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + 0.26);
}
function punchySnare(ctx, master, t, gain) {
	var dur = 0.11;
	var samples = Math.floor(ctx.sampleRate * dur);
	var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
	var data = buf.getChannelData(0);
	for (var i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 0.9);
	var src = ctx.createBufferSource(); src.buffer = buf;
	var bp = ctx.createBiquadFilter();
	bp.type = "bandpass"; bp.frequency.value = 2600; bp.Q.value = 2.2;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 1.2, t + 0.002);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	src.connect(bp); bp.connect(g); g.connect(master);
	src.start(t);
}
function punchyHihat(ctx, master, t, gain) {
	var dur = 0.035;
	var samples = Math.floor(ctx.sampleRate * dur);
	var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
	var data = buf.getChannelData(0);
	for (var i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 2.5);
	var src = ctx.createBufferSource(); src.buffer = buf;
	var hp = ctx.createBiquadFilter();
	hp.type = "highpass"; hp.frequency.value = 8500;
	var g = ctx.createGain(); g.gain.value = gain * 1.1;
	src.connect(hp); hp.connect(g); g.connect(master);
	src.start(t);
}

function lofiKick(ctx, master, t, gain) {
	var osc = ctx.createOscillator();
	osc.type = "sine";
	osc.frequency.setValueAtTime(130, t);
	osc.frequency.exponentialRampToValueAtTime(45, t + 0.1);
	var filt = ctx.createBiquadFilter();
	filt.type = "lowpass"; filt.frequency.value = 500;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 0.85, t + 0.006);
	g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
	osc.connect(filt); filt.connect(g); g.connect(master);
	osc.start(t); osc.stop(t + 0.18);
}
function lofiSnare(ctx, master, t, gain) {
	var dur = 0.12;
	var samples = Math.floor(ctx.sampleRate * dur);
	var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
	var data = buf.getChannelData(0);
	for (var i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 1.6);
	var src = ctx.createBufferSource(); src.buffer = buf;
	var lp = ctx.createBiquadFilter();
	lp.type = "lowpass"; lp.frequency.value = 1400;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain * 0.8, t + 0.004);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	src.connect(lp); lp.connect(g); g.connect(master);
	src.start(t);
}
function lofiHihat(ctx, master, t, gain) {
	var dur = 0.05;
	var samples = Math.floor(ctx.sampleRate * dur);
	var buf = ctx.createBuffer(1, samples, ctx.sampleRate);
	var data = buf.getChannelData(0);
	for (var i = 0; i < samples; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples, 2);
	var src = ctx.createBufferSource(); src.buffer = buf;
	var bp = ctx.createBiquadFilter();
	bp.type = "bandpass"; bp.frequency.value = 4500; bp.Q.value = 0.6;
	var g = ctx.createGain(); g.gain.value = gain * 0.7;
	src.connect(bp); bp.connect(g); g.connect(master);
	src.start(t);
}

// music.lab.electroKick/electroSnare/electroHihat's real signature is (t, gain), same
// closure-ctx/master pattern as the Classic kit's adapters above.
function playElectroKick(ctx, master, t, gain) { music.lab.electroKick(t, gain); }
function playElectroSnare(ctx, master, t, gain) { music.lab.electroSnare(t, gain); }
function playElectroHihat(ctx, master, t, gain) { music.lab.electroHihat(t, gain); }

var BATTLE_LAB_PERC_KITS = [
	{ id: "electro", label: "Electro", desc: "808-style booming kick, a layered clap instead of a snare, crisp metallic hats — the shipped kit.", kick: playElectroKick, snare: playElectroSnare, hihat: playElectroHihat },
	{ id: "classic", label: "Classic", desc: "Sine kick, noise-burst snare, bright hi-hat — simpler and punchier, less low-end.", kick: percKick, snare: percSnare, hihat: percHihat },
	{ id: "punchy", label: "Punchy", desc: "Harder-hitting kick and snare — more low-end thump, a tighter crack.", kick: punchyKick, snare: punchySnare, hihat: punchyHihat },
	{ id: "lofi", label: "Lo-fi", desc: "Everything filtered and softened — a muffled, vinyl-ish character.", kick: lofiKick, snare: lofiSnare, hihat: lofiHihat }
];

// The shipped percussion pattern — mirrors Music.js's DRUM_KICK_BEATS/DRUM_SNARE_BEATS exactly,
// so this option previews the real pattern rather than a lookalike.
function percRhythmBreakbeat(kit, ctx, master, t, beatS, gain) {
	[0, 1.5, 2.75].forEach(function(b) { kit.kick(ctx, master, t + b * beatS, gain.kick); });
	kit.snare(ctx, master, t + 1 * beatS, gain.snare);
	kit.snare(ctx, master, t + 3 * beatS, gain.snare);
	for (var h = 0; h < 16; h++) {
		kit.hihat(ctx, master, t + h * beatS * 0.25, gain.hat * (h % 4 === 0 ? 1.1 : 0.6));
	}
}
function percRhythmFourFloor(kit, ctx, master, t, beatS, gain) {
	for (var b = 0; b < 4; b++) kit.kick(ctx, master, t + b * beatS, gain.kick);
	kit.snare(ctx, master, t + 1 * beatS, gain.snare);
	kit.snare(ctx, master, t + 3 * beatS, gain.snare);
	for (var h = 0; h < 8; h++) {
		kit.hihat(ctx, master, t + h * beatS * 0.5, gain.hat * (h % 2 === 1 ? 1.2 : 0.7));
	}
}
function percRhythmHalfTime(kit, ctx, master, t, beatS, gain) {
	kit.kick(ctx, master, t, gain.kick);
	kit.snare(ctx, master, t + 2 * beatS, gain.snare);
	for (var h = 0; h < 4; h++) kit.hihat(ctx, master, t + h * beatS, gain.hat);
}
function percRhythmMinimal(kit, ctx, master, t, beatS, gain) {
	kit.kick(ctx, master, t, gain.kick);
	kit.kick(ctx, master, t + 2 * beatS, gain.kick);
	kit.snare(ctx, master, t + 1 * beatS, gain.snare);
	kit.snare(ctx, master, t + 3.75 * beatS, gain.snare * 0.5);
	kit.snare(ctx, master, t + 3 * beatS, gain.snare);
	for (var h = 0; h < 16; h++) kit.hihat(ctx, master, t + h * beatS * 0.25, gain.hat * 0.8);
}

var BATTLE_LAB_PERC_RHYTHMS = [
	{ id: "breakbeat", label: "Breakbeat", desc: "Syncopated kick hits ahead of the beat, snare on 2 & 4, hi-hat 16ths — the shipped pattern.", schedule: percRhythmBreakbeat },
	{ id: "fourfloor", label: "Four-on-the-floor", desc: "Kick every beat, snare on 2 & 4, hi-hat 8ths — a steadier, less rolling groove.", schedule: percRhythmFourFloor },
	{ id: "halftime", label: "Half-time", desc: "Kick on 1, snare only on 3, hi-hat quarters — half the density, more space.", schedule: percRhythmHalfTime },
	{ id: "minimal", label: "Minimal", desc: "Kick on 1 & 3 only, a ghost snare before the backbeat, steady 16th hi-hats underneath.", schedule: percRhythmMinimal }
];

// -- progressions: 4 bars of {root, arp}, same A-minor/C-major key centre — arp values are the
// real chord tones (reused verbatim for Am/Em/F/C/G; Dm added the same way) so the melody layer
// stays harmonized with the bass no matter which progression is picked.
var BATTLE_LAB_PROGRESSIONS = [
	{ id: "amemfc", label: "Am–Em–F–C", desc: "Em in place of the more usual second chord — moodier, more melancholic. Section A of the shipped song (see the note on the combined loop below).", bars: [
		{ root: 110.00, arp: [220.00, 261.63, 329.63, 440.00] },
		{ root: 82.41,  arp: [164.81, 196.00, 246.94, 329.63] },
		{ root: 87.31,  arp: [174.61, 220.00, 261.63, 349.23] },
		{ root: 130.81, arp: [261.63, 329.63, 392.00, 523.25] }
	] },
	{ id: "amdmgc", label: "Am–Dm–G–C", desc: "Descends through the circle of fifths — a more cinematic, driving pull toward C. Section B of the shipped song, paired there with a straight-16th bass and a sixteenth-run melody for a denser, more driving feel than Section A.", bars: [
		{ root: 110.00, arp: [220.00, 261.63, 329.63, 440.00] },
		{ root: 73.42,  arp: [146.83, 174.61, 220.00, 293.66] },
		{ root: 98.00,  arp: [196.00, 246.94, 293.66, 392.00] },
		{ root: 130.81, arp: [261.63, 329.63, 392.00, 523.25] }
	] },
	{ id: "amfcg", label: "Am–F–C–G", desc: "The \"axis of awesome\" progression — brighter and more resolved than either shipped section.", bars: [
		{ root: 110.00, arp: [220.00, 261.63, 329.63, 440.00] },
		{ root: 87.31,  arp: [174.61, 220.00, 261.63, 349.23] },
		{ root: 130.81, arp: [261.63, 329.63, 392.00, 523.25] },
		{ root: 98.00,  arp: [196.00, 246.94, 293.66, 392.00] }
	] },
	{ id: "amgcf", label: "Am–G–C–F", desc: "Same four chords as the axis-of-awesome progression, reordered — resolves to F instead of G, a softer landing each loop.", bars: [
		{ root: 110.00, arp: [220.00, 261.63, 329.63, 440.00] },
		{ root: 98.00,  arp: [196.00, 246.94, 293.66, 392.00] },
		{ root: 130.81, arp: [261.63, 329.63, 392.00, 523.25] },
		{ root: 87.31,  arp: [174.61, 220.00, 261.63, 349.23] }
	] },
	{ id: "cgamf", label: "C–G–Am–F", desc: "The classic four-chord pop progression, same key centre — opens major instead of minor.", bars: [
		{ root: 130.81, arp: [261.63, 329.63, 392.00, 523.25] },
		{ root: 98.00,  arp: [196.00, 246.94, 293.66, 392.00] },
		{ root: 110.00, arp: [220.00, 261.63, 329.63, 440.00] },
		{ root: 87.31,  arp: [174.61, 220.00, 261.63, 349.23] }
	] }
];

// The currently selected option on each axis, and each layer's on/off state — persists across
// re-renders of this page within the same session (not that a re-render normally happens without
// a full navigate-away/back, which resets playback anyway via teardownSoundLab).
var battleLabSelected = {
	progression: BATTLE_LAB_PROGRESSIONS[0],
	bass: { on: true, timbre: BATTLE_LAB_TIMBRES[0], rhythm: BATTLE_LAB_RHYTHMS[0] },
	melody: { on: true, timbre: BATTLE_LAB_MELODY_TIMBRES[0], rhythm: BATTLE_LAB_MELODY_RHYTHMS[0] },
	perc: { on: true, kit: BATTLE_LAB_PERC_KITS[0], rhythm: BATTLE_LAB_PERC_RHYTHMS[0] }
};
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

// Loops the selected progression through whichever layers are switched on, one bar at a time via
// a setTimeout chain (same idiom as Overlay.js's countdownDigitCycle) — Stop just clears the
// pending timer; the current bar's already-scheduled notes finish naturally, well under 2s.
// Reads battleLabSelected fresh every bar, so switching any axis — including a layer's on/off
// toggle — mid-loop takes effect on the very next bar instead of requiring a restart.
function playBattleLabBar() {
	var ctx = music.lab.getCtx();
	var master = music.lab.getMaster();
	if (!ctx || !master) return;
	var rate = sound.getRate();
	var beatS = music.lab.BEAT_S / rate;
	var barDurMs = (music.lab.BAR_DUR / rate) * 1000;
	var bar = battleLabSelected.progression.bars[battleLabBarIdx % battleLabSelected.progression.bars.length];
	var t = ctx.currentTime + 0.05;
	var bass = battleLabSelected.bass;
	if (bass.on) bass.rhythm.schedule(bass.timbre.synth, ctx, master, bar.root, t, beatS, BASS_PREVIEW_GAIN);
	var melody = battleLabSelected.melody;
	if (melody.on) melody.rhythm.schedule(melody.timbre.synth, ctx, master, bar.arp, t, beatS, MELODY_PREVIEW_GAIN);
	var perc = battleLabSelected.perc;
	if (perc.on) perc.rhythm.schedule(perc.kit, ctx, master, t, beatS, PERC_PREVIEW_GAIN);
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

// The on/off toggle on a layer's header — same .toggle-switch button Fullscreen.js's "Auto
// fullscreen" setting uses. Mutates layerState.on directly so playBattleLabBar sees it live.
function buildBattleLabLayerToggle(layerState) {
	var sw = document.createElement("button");
	sw.type = "button";
	sw.className = "toggle-switch sound-lab-layer-toggle" + (layerState.on ? " on" : "");
	sw.setAttribute("aria-pressed", layerState.on ? "true" : "false");
	sw.addEventListener("click", function() {
		layerState.on = !layerState.on;
		sw.classList.toggle("on", layerState.on);
		sw.setAttribute("aria-pressed", layerState.on ? "true" : "false");
	});
	return sw;
}

// One layer card (Bass / Melody / Percussion): a title + on/off toggle, then its two axis
// pickers. axisOneKey/axisTwoKey are the fields on layerState each picker writes to (e.g.
// "timbre"/"rhythm" for bass and melody, "kit"/"rhythm" for percussion).
function buildBattleLabLayer(title, layerState, axisOneLabel, axisOneOptions, axisOneKey, axisTwoLabel, axisTwoOptions, axisTwoKey) {
	var layer = document.createElement("div");
	layer.className = "sound-lab-layer";

	var head = document.createElement("div");
	head.className = "sound-lab-layer-head";
	var lbl = document.createElement("span");
	lbl.className = "sound-lab-layer-title";
	lbl.textContent = title;
	head.appendChild(lbl);
	head.appendChild(buildBattleLabLayerToggle(layerState));
	layer.appendChild(head);

	var axes = document.createElement("div");
	axes.className = "sound-lab-layer-axes";
	axes.appendChild(buildBattleLabAxis(axisOneLabel, axisOneOptions, layerState, axisOneKey));
	axes.appendChild(buildBattleLabAxis(axisTwoLabel, axisTwoOptions, layerState, axisTwoKey));
	layer.appendChild(axes);

	return layer;
}

// The "Battle theme lab" card: a shared Progression picker (drives both bass root and melody
// arpeggio), then the Bass / Melody / Percussion layers — each independently switchable — feeding
// the one combined Play/Stop loop in playBattleLabBar.
function buildBattleLabSection() {
	var section = document.createElement("div");
	section.className = "sound-lab-section";
	var head = document.createElement("h2");
	head.className = "controls-title";
	head.textContent = "Battle theme lab";
	section.appendChild(head);
	var sp = document.createElement("p");
	sp.className = "sound-lab-section-sub";
	sp.textContent = "Bass, melody, and percussion, each with its own voice + rhythm and its own on/off switch — solo a layer, mute the drums, or play any combination together over a shared chord progression. Loops the current selection until you stop it; switching anything mid-loop takes effect on the next bar.";
	section.appendChild(sp);

	var card = document.createElement("div");
	card.className = "section-card sound-lab-battle-card";

	card.appendChild(buildBattleLabAxis("Progression", BATTLE_LAB_PROGRESSIONS, battleLabSelected, "progression"));
	card.appendChild(buildBattleLabLayer("Bass", battleLabSelected.bass, "Timbre", BATTLE_LAB_TIMBRES, "timbre", "Rhythm", BATTLE_LAB_RHYTHMS, "rhythm"));
	card.appendChild(buildBattleLabLayer("Melody", battleLabSelected.melody, "Timbre", BATTLE_LAB_MELODY_TIMBRES, "timbre", "Rhythm", BATTLE_LAB_MELODY_RHYTHMS, "rhythm"));
	card.appendChild(buildBattleLabLayer("Percussion", battleLabSelected.perc, "Kit", BATTLE_LAB_PERC_KITS, "kit", "Pattern", BATTLE_LAB_PERC_RHYTHMS, "rhythm"));

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
