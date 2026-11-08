// Restore the saved theme before first paint (loaded from index.html, not
// inlined, so the Content-Security-Policy can forbid inline scripts). With no
// saved choice the CSS follows prefers-color-scheme.
try {
  var t = localStorage.getItem("carintel-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
