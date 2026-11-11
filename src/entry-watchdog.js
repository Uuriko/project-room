// Independent of the module graph: a failed dependency prevents entry.js's
// own recovery handler from running. CSP permits this external classic script.
(function () {
  var retry = document.getElementById("entry-load-retry");
  if (!retry) return;
  retry.addEventListener("click", function () { location.reload(); });
  function showRecovery() {
    if (document.documentElement.dataset.entryStarted) return;
    var recovery = document.getElementById("entry-load-recovery");
    if (recovery) recovery.hidden = false;
  }
  var timer = setTimeout(showRecovery, 15000);
  var entry = document.getElementById("entry-module");
  if (entry) entry.addEventListener("error", function () {
    clearTimeout(timer);
    showRecovery();
  }, { once: true });
})();
