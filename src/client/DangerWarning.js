// Tournament "danger" warning. Lightly pulses a red border around the
// player's board when they're currently below the elimination cut for the
// current round. Uses hysteresis so a tight battle near the cut line doesn't
// strobe, and gates on a grace window so the warning never appears right at
// the round start.

function setDanger(on) {
	if (!dangerTarget) dangerTarget = document.getElementById("player_div");
	if (!dangerTarget) return;
	if (dangerActive === on) return;
	dangerActive = on;
	dangerTarget.classList.toggle("danger", on);
}

// Subtle red pulse around the player's own board when they're currently below
// the elimination cut for this tournament round. Activates only after a grace
// period into the round, with hysteresis so a tight battle doesn't strobe.
function updateDangerWarning() {
	if (!currentRoom || currentRoom.rankedMode !== "tournament"
		|| currentRoom.phase !== "playing"
		|| iAmEliminated
		|| (liveProgress[id] && liveProgress[id].finished)) {
		setDanger(false);
		return;
	}
	// Grace window after GO: no warning yet.
	if (!roundStartTime || Date.now() - roundStartTime < DANGER_GRACE_MS) {
		setDanger(false);
		return;
	}
	var schedule = currentRoom.tournamentSchedule || [];
	var survivors = schedule[currentRoom.gamesPlayed || 0];
	if (!survivors) { setDanger(false); return; }
	// Sort players by progress (same ordering as the scoreboard).
	var sorted = currentRoom.players.slice().sort(function(a, b) {
		var lpa = liveProgress[a.id] || {}, lpb = liveProgress[b.id] || {};
		if (lpa.finished !== lpb.finished) return lpa.finished ? -1 : 1;
		if (lpa.finished && lpb.finished) return (lpa.finishedAt || 0) - (lpb.finishedAt || 0);
		return (lpb.progress || 0) - (lpa.progress || 0);
	});
	var myIdx = -1;
	for (var i = 0; i < sorted.length; i++) if (sorted[i].id === id) { myIdx = i; break; }
	if (myIdx === -1) return;
	// Hysteresis: enter danger when below the cut, exit only after climbing one
	// full rank into safety. Stops oscillation at the boundary.
	if (!dangerActive && myIdx >= survivors) setDanger(true);
	else if (dangerActive && myIdx < survivors - 1) setDanger(false);
}
