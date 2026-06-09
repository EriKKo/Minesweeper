// Server-sent board decoder.
//
// The server XOR-masks each round's mine layout and ships the bytes to every
// player. boardDecoder decodes (r, c) lazily so the underlying data is harder
// to dump from the JS console. boardCell is the only allowed accessor — the
// raw bytes never leave installBoardDecoder's closure.

var boardDecoder = null;
// Cells whose value changed after the decoder was installed (territory mine-explosion re-gen
// rewrites a patch of the board). Checked first so boardCell reflects the live layout.
var boardOverride = null;
function boardCell(r, c) {
	if (boardOverride) { var k = r + "," + c; if (k in boardOverride) return boardOverride[k]; }
	return boardDecoder ? boardDecoder(r, c) : 0;
}
function patchBoardCells(clues) { if (!boardOverride) boardOverride = {}; for (var k in clues) boardOverride[k] = clues[k]; }

function installBoardDecoder(dataB64, maskB64, decodeRows, decodeCols) {
	boardOverride = null; // fresh layout — drop any prior explosion patches
	var data = base64ToBytes(dataB64);
	var mask = base64ToBytes(maskB64);
	var width = decodeCols;
	boardDecoder = function(r, c) {
		var idx = r * width + c;
		var v = data[idx] ^ mask[idx % mask.length];
		return v === 9 ? MINE : v;
	};
}

function base64ToBytes(s) {
	var bin = atob(s);
	var out = new Uint8Array(bin.length);
	for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
