// Country support for the avatar / profile country picker.
//
// We deliberately DON'T hardcode country names. The browser's Intl.DisplayNames maps each ISO-3166
// alpha-2 code to a localized name at runtime — accurate, localized, and nothing to maintain. The only
// embedded data is the list of codes (just letter pairs), mirroring the flag SVGs under /flags/<code>.svg
// that were copied from the trevelur project. Flag art is an <img>, so it renders identically on every
// platform (unlike flag emoji, which Windows doesn't render).
(function () {
	// Codes that have a flag SVG in /flags. Kept as a plain code list; names come from Intl at runtime.
	var CODES = ("ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo " +
		"br bs bt bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee " +
		"eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gt gu gw gy hk hn hr ht " +
		"hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls " +
		"lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na ne nf ng ni nl no " +
		"np nr nu nz om pa pe pf pg ph pk pl pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk " +
		"sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug us uy uz va " +
		"vc ve vg vi vn vu ws xk ye yt za zm zw").split(" ");

	var regionNames = null;
	try { regionNames = new Intl.DisplayNames(undefined, { type: "region" }); } catch (e) {}

	// Localized country name for a code, falling back to the upper-cased code if the runtime can't resolve it.
	function countryName(code) {
		if (!code) return "";
		var cc = String(code).toUpperCase();
		if (regionNames) { try { var n = regionNames.of(cc); if (n && n !== cc) return n; } catch (e) {} }
		return cc;
	}

	function countryFlagSrc(code) { return code ? "/flags/" + String(code).toLowerCase() + ".svg" : null; }

	// [{ code, name }] sorted by localized name — feeds the picker dropdown.
	function countryList() {
		return CODES.map(function (c) { return { code: c, name: countryName(c) }; })
			.sort(function (a, b) { return a.name.localeCompare(b.name); });
	}

	window.COUNTRY_CODES = CODES;
	window.countryName = countryName;
	window.countryFlagSrc = countryFlagSrc;
	window.countryList = countryList;
})();
