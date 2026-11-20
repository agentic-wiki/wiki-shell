// Applied before the first paint, as a blocking script in the page's head. Read
// after React mounts, the theme would flash the system default first, and the
// width would reflow the column underneath the text you were already reading.
// A file of its own rather than inline, because the Content-Security-Policy
// runs only the app's own scripts.
try {
  var t = localStorage.getItem("wiki:theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  if (localStorage.getItem("wiki:width") === "wide") document.documentElement.setAttribute("data-width", "wide");
} catch (e) {
  // Storage can be unavailable (private mode, blocked cookies). The system
  // theme is a fine answer; the toggle just will not persist.
}
