// Server-sent board decoder.
//
// The server XOR-masks each round's mine layout and ships the bytes to every
// player. boardDecoder decodes (r, c) lazily so the underlying data is harder
// to dump from the JS console. boardCell is the only allowed accessor — the
// raw bytes never leave installBoardDecoder's closure.

var boardDecoder = null;
function boardCell(r, c) { return boardDecoder ? boardDecoder(r, c) : 0; }

function installBoardDecoder(dataB64, maskB64, decodeRows, decodeCols) {
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
