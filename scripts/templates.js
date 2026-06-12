// Code registry of board-layout templates for the template scout (scripts/template-scout.js).
//
// Each pattern has a stable `id` — puzzles the scout generates from it are stored with
// source = "template:<id>", so you can find them later (e.g. the All-puzzles admin filtered by that
// source, or `SELECT * FROM puzzles WHERE source = 'template:<id>'`). Add new layouts here.
//
// Token legend (see template-scout.js header for full details):
//   0-8 revealed-fixed · ? revealed-any · # covered-any/free · * covered-mine · s covered-safe-any ·
//   A-I covered-safe-fixed(0..8) · aliases . = # , M = *
module.exports = {
	"two-mine": {
		name: "4x4 opening, two covered mines",
		grid: `
# # # # # #
# ? * ? ? #
# ? ? ? ? #
# ? ? ? ? #
# ? ? * ? #
# # # # # #`
	},
	"corner4": {
		name: "4x4 opening, one corner mine",
		grid: `
# # # # # #
# * ? ? ? #
# ? ? ? ? #
# ? ? ? ? #
# ? ? ? ? #
# # # # # #`
	},
	"wall-1221": {
		name: "1-2-2-1 wall over a covered row",
		grid: `
# # # # #
1 2 2 1 #
# # # # #`
	},
	"ring4224": {
		name: "corners-4 / edges-2 ring with a 0-core, mined border + a corner 2",
		grid: `
2 # # # # #
* * # # * *
# 4 2 2 4 #
* 2 0 0 2 *
# 4 2 2 4 #
* * # # * *`
	}
};
