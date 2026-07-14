// Admin "Sound Lab" (/admin/sounds) — every sound effect the game has, each with its own Play
// button, plus a shared playback-rate slider for auditioning a clip snappier or more drawn-out
// without touching its pitch. Two sections: the real sound.* methods (Sound.js) that ship in
// gameplay, played exactly as they'd play in a match; and a set of alternate takes on the
// idle→ready sweep sound (sound.sweep — currently "Shimmer"), built from the same sound.lab.tone/
// arp primitives Sound.js itself uses, for comparing candidates before picking one to ship.

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

// Called from hideAllViews (Router.js) whenever any view changes — same convention as
// teardownCountdownLab. The only state this page touches outside itself is sound's playback
// rate, so that's the only thing that needs resetting on the way out.
function teardownSoundLab() {
	sound.setRate(1);
}
