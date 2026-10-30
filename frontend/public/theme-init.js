// Restore the saved theme before first paint (loaded from index.html, not
// inlined, so the Content-Security-Policy can forbid inline scripts).
try {
  var t = localStorage.getItem("carintel-theme");
  if (t && t !== "light") document.documentElement.classList.add("theme-" + t);
} catch (e) {}
