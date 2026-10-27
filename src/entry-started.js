// Imported last by both startup modules (entry.js and the legacy direct
// app.js path in cached HTML), so it runs only after their earlier static
// imports evaluate. The readable static fallback yields only then.
document.documentElement.dataset.entryStarted = "true";
