// Rebindable in-game keyboard controls, persisted to localStorage. Input.js asks
// `keybindings.actionFor(event)` to map a keydown to an action; the Profile page renders
// a Controls section (renderKeybindings) for changing them; the in-game hint line is
// rebuilt from the current bindings (updateHotkeyHint). Shift stays a fixed modifier:
// held with movement it skips revealed cells, and it reverses the "next unsolved" jump.

var keybindings = (function() {
	// Order here is the order shown in the Controls section.
	var ACTIONS = [
		{ id: "up", label: "Move up" },
		{ id: "down", label: "Move down" },
		{ id: "left", label: "Move left" },
		{ id: "right", label: "Move right" },
		{ id: "reveal", label: "Reveal cell" },
		{ id: "flag", label: "Flag / unflag" },
		{ id: "next", label: "Jump to next unsolved area" }
	];
	var DEFAULTS = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", reveal: " ", flag: "z", next: "Tab" };

	function freshDefaults() {
		var out = {};
		for (var k in DEFAULTS) out[k] = DEFAULTS[k];
		return out;
	}
	var binds = freshDefaults();
	try {
		var raw = localStorage.getItem("ms_keybinds");
		if (raw) {
			var parsed = JSON.parse(raw);
			for (var a in DEFAULTS) if (typeof parsed[a] === "string" && parsed[a]) binds[a] = parsed[a];
		}
	} catch (e) {}

	function save() { try { localStorage.setItem("ms_keybinds", JSON.stringify(binds)); } catch (e) {} }

	// Compare keys case-insensitively for single characters (so "z"/"Z" match), exactly
	// otherwise ("ArrowUp", "Tab", " ").
	function norm(key) { return (key && key.length === 1) ? key.toLowerCase() : key; }

	// Map a keydown event to an action id (or null if the key isn't bound).
	function actionFor(e) {
		var k = norm(e.key);
		for (var a in binds) if (norm(binds[a]) === k) return a;
		return null;
	}

	// Bind `action` to `key`; if another action already uses that key, swap them so
	// every action stays bound and no two share a key.
	function set(action, key) {
		if (!binds.hasOwnProperty(action)) return;
		var old = binds[action];
		for (var b in binds) if (b !== action && norm(binds[b]) === norm(key)) binds[b] = old;
		binds[action] = key;
		save();
	}

	function reset() { binds = freshDefaults(); save(); }

	// Human-friendly label for a key string.
	function label(key) {
		switch (key) {
			case " ": return "Space";
			case "ArrowUp": return "↑";
			case "ArrowDown": return "↓";
			case "ArrowLeft": return "←";
			case "ArrowRight": return "→";
			case "Tab": return "Tab";
			case "Enter": return "Enter";
			case "Escape": return "Esc";
			case "Backspace": return "⌫";
		}
		if (key && key.length === 1) return key.toUpperCase();
		return key || "—";
	}

	return {
		ACTIONS: ACTIONS,
		actionFor: actionFor,
		get: function(a) { return binds[a]; },
		set: set,
		reset: reset,
		label: label
	};
})();

// Rebuild the in-game controls hint line from the current bindings.
function updateHotkeyHint() {
	var el = document.querySelector(".hotkey-hint");
	if (!el) return;
	var L = keybindings.label;
	el.textContent =
		"Move: " + L(keybindings.get("up")) + L(keybindings.get("left")) + L(keybindings.get("down")) + L(keybindings.get("right")) +
		" (Shift = skip revealed) · Next: " + L(keybindings.get("next")) +
		" · Reveal: " + L(keybindings.get("reveal")) +
		" · Flag: " + L(keybindings.get("flag")) +
		" — rebind in Profile";
}

// Render the Controls section on the Profile page. Clicking a key enters capture mode;
// the next key press (other than a bare modifier; Esc cancels) becomes the binding.
var keybindCapturing = false;
function renderKeybindings() {
	var card = document.getElementById("controls_card");
	if (!card) return;
	card.innerHTML = "";

	var h = document.createElement("h2");
	h.className = "controls-title";
	h.textContent = "Controls";
	card.appendChild(h);

	var sub = document.createElement("p");
	sub.className = "section-stub-note";
	sub.style.marginTop = "0";
	sub.textContent = "Keyboard controls for solving. Click a key to rebind it. Hold Shift with movement to skip revealed cells.";
	card.appendChild(sub);

	var list = document.createElement("div");
	list.className = "keybind-list";
	keybindings.ACTIONS.forEach(function(act) {
		var row = document.createElement("div");
		row.className = "keybind-row";
		var label = document.createElement("span");
		label.className = "keybind-label";
		label.textContent = act.label;
		row.appendChild(label);
		var keyBtn = document.createElement("button");
		keyBtn.type = "button";
		keyBtn.className = "keybind-key";
		keyBtn.textContent = keybindings.label(keybindings.get(act.id));
		keyBtn.addEventListener("click", function() { captureKey(act.id, keyBtn); });
		row.appendChild(keyBtn);
		list.appendChild(row);
	});
	card.appendChild(list);

	var reset = document.createElement("button");
	reset.type = "button";
	reset.className = "btn btn-secondary keybind-reset";
	reset.textContent = "Reset to defaults";
	reset.addEventListener("click", function() {
		keybindings.reset();
		renderKeybindings();
		updateHotkeyHint();
	});
	card.appendChild(reset);
}

function captureKey(action, btn) {
	if (keybindCapturing) return;
	keybindCapturing = true;
	btn.classList.add("capturing");
	btn.textContent = "Press a key…";
	function onKey(e) {
		e.preventDefault();
		e.stopPropagation();
		var k = e.key;
		if (k === "Escape") { finish(); return; }            // cancel
		if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return; // ignore bare modifiers
		keybindings.set(action, k);
		finish();
	}
	function finish() {
		document.removeEventListener("keydown", onKey, true);
		keybindCapturing = false;
		renderKeybindings();
		updateHotkeyHint();
	}
	document.addEventListener("keydown", onKey, true);
}

// Set the in-game hint once the page is parsed.
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", updateHotkeyHint);
} else {
	updateHotkeyHint();
}
