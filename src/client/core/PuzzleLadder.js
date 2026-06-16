// Puzzle Ladder progression — a chess.com-style monotonic points track laid over the puzzle trainer.
// Points only ever go up (awarded per rated solve, server-side); they drive a tier + level. Difficulty
// is still set by the two-way puzzle RATING, which is separate and de-emphasised.
//
// 8 tiers × 20 levels, flat points per level. All tunable here — change the tiers/levels/points freely.
(function () {
	var PUZZLE_TIERS = [
		{ name: "Wood",     color: "#b0814f" },
		{ name: "Stone",    color: "#9aa1ab" },
		{ name: "Bronze",   color: "#cd7f32" },
		{ name: "Silver",   color: "#cbd3df" },
		{ name: "Crystal",  color: "#56d6e6" },
		{ name: "Elite",    color: "#8b6cff" },
		{ name: "Champion", color: "#ffb020" },
		{ name: "Legend",   color: "#ff5d73" }
	];
	var LEVELS_PER_TIER = 20;
	var POINTS_PER_LEVEL = 50;
	var MAX_LEVEL = PUZZLE_TIERS.length * LEVELS_PER_TIER; // 160

	// Resolve a points total into tier/level display info.
	function puzzleLadder(points) {
		points = Math.max(0, Math.round(points || 0));
		var levelGlobal = Math.floor(points / POINTS_PER_LEVEL); // 0-based count of completed levels
		var atMax = levelGlobal >= MAX_LEVEL;
		var tierIndex = atMax ? PUZZLE_TIERS.length - 1 : Math.floor(levelGlobal / LEVELS_PER_TIER);
		var levelInTier = atMax ? LEVELS_PER_TIER : (levelGlobal % LEVELS_PER_TIER); // 0-based
		var tier = PUZZLE_TIERS[tierIndex];
		var into = points - levelGlobal * POINTS_PER_LEVEL;
		return {
			points: points,
			tierIndex: tierIndex,
			tierName: tier.name,
			tierColor: tier.color,
			level: atMax ? LEVELS_PER_TIER : (levelInTier + 1), // 1-based, 1..20
			atMax: atMax,
			pointsPerLevel: POINTS_PER_LEVEL,
			pointsIntoLevel: atMax ? POINTS_PER_LEVEL : into,
			levelPct: atMax ? 100 : Math.round(into / POINTS_PER_LEVEL * 100)
		};
	}

	// "Wood · Lvl 3" / "Legend · Max".
	function puzzleLadderLabel(points) {
		var l = puzzleLadder(points);
		return l.tierName + " · " + (l.atMax ? "Max" : "Lvl " + l.level);
	}

	window.puzzleLadder = puzzleLadder;
	window.puzzleLadderLabel = puzzleLadderLabel;
})();
