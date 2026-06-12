// Shared helpers for the paginated admin list views (All Puzzles, Bots, Patterns,
// Starting positions). Each view keeps its own filter state and row rendering, but
// the pager and the URL-filter-state write are identical, so they live here.
//
// Loaded via a plain <script> tag before those views; everything here is a global.

// Render a pager into #containerId: ← Prev / [1 … window … N] / Next →, calling
// onGoto(targetPage) when the user picks a page. Hidden when there's a single page.
function renderPager(containerId, total, page, pageSize, onGoto) {
	var pager = document.getElementById(containerId);
	if (!pager) return;
	pager.innerHTML = "";
	var totalPages = Math.max(1, Math.ceil(total / pageSize));
	if (totalPages <= 1) return;

	function addBtn(label, target, opts) {
		opts = opts || {};
		var b = document.createElement("button");
		b.className = "puzzles-pager-btn" + (opts.current ? " current" : "");
		b.textContent = label;
		b.disabled = !!opts.disabled || target === page;
		b.addEventListener("click", function() {
			if (target === page) return;
			onGoto(Math.max(0, Math.min(totalPages - 1, target)));
		});
		pager.appendChild(b);
	}
	function dots() {
		var d = document.createElement("span");
		d.className = "puzzles-pager-dots";
		d.textContent = "…";
		pager.appendChild(d);
	}

	addBtn("← Prev", page - 1, { disabled: page <= 0 });
	// Compact numeric range around the current page, with first/last + ellipses.
	var windowSize = 5;
	var start = Math.max(0, page - Math.floor(windowSize / 2));
	var end = Math.min(totalPages - 1, start + windowSize - 1);
	start = Math.max(0, end - windowSize + 1);
	if (start > 0) { addBtn("1", 0); if (start > 1) dots(); }
	for (var i = start; i <= end; i++) addBtn(String(i + 1), i, { current: i === page });
	if (end < totalPages - 1) { if (end < totalPages - 2) dots(); addBtn(String(totalPages), totalPages - 1); }
	addBtn("Next →", page + 1, { disabled: page >= totalPages - 1 });
}

// Turn `bits` (["key=value", …]) into a query string and replaceState it onto the
// current path — only when it actually changed, so reloading keeps the filters.
function applyQueryString(bits) {
	var qs = bits.length ? "?" + bits.join("&") : "";
	if (location.search !== qs) history.replaceState(null, "", location.pathname + qs);
}
