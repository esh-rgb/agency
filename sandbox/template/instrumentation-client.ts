// Scripts from the Agency platform. In the dev server's preview inside the builder: pointing at parts
// of the app ("change this"). In the published app: a "Suggest an improvement" button that opens Ideas.
const platform = `${location.protocol}//${location.host.replace(/^[^.]+\./, "")}`;
const agencyScript =
	process.env.NODE_ENV === "development" ? (window.parent !== window ? "preview-select.js" : "") : window.parent === window ? "suggest.js" : "";
if (agencyScript) {
	const script = document.createElement("script");
	script.src = `${platform}/static/${agencyScript}`;
	script.async = true;
	document.head.append(script);
}
