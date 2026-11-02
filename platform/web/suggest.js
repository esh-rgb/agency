// "Suggest an improvement": a small button in the corner of published apps. It opens Ideas in Agency
// with the app filled in, so the people who use an app can tell its builders what would make it better.
// The platform serves this script; apps load it from instrumentation-client.ts. Its text is ASCII with
// escapes, so it reads right whatever character set the app's page declares.
(() => {
	if (document.getElementById("agency-suggest")) return;
	const [slug, ...rest] = location.hostname.split(".");
	const platform = `${location.protocol}//${rest.join(".")}`;
	const hebrew = (navigator.language || "").toLowerCase().startsWith("he") || document.documentElement.lang === "he";
	const link = document.createElement("a");
	link.id = "agency-suggest";
	link.href = `${platform}/#/ideas/new?app=${encodeURIComponent(slug)}`;
	link.target = "_blank";
	link.rel = "noopener";
	link.textContent = hebrew ? "\ud83d\udca1 \u05d4\u05e6\u05e2 \u05e9\u05d9\u05e4\u05d5\u05e8" : "\ud83d\udca1 Suggest an improvement";
	link.setAttribute("style", [
		"position:fixed", "bottom:16px", "inset-inline-end:16px", "z-index:2147483000",
		"padding:8px 12px", "border-radius:999px", "font:500 13px/1.2 system-ui,sans-serif",
		"background:#111117", "color:#fff", "text-decoration:none", "opacity:.85",
		"box-shadow:0 4px 16px rgb(0 0 0 / .18)",
	].join(";"));
	link.addEventListener("mouseenter", () => (link.style.opacity = "1"));
	link.addEventListener("mouseleave", () => (link.style.opacity = ".85"));
	document.body.append(link);
})();
