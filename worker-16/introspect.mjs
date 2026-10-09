const m = await import("../scripts/acceptance-fixture.mjs");
const f = m.createAcceptanceFixture();
console.log("fixture keys:", Object.keys(f).join(","));
console.log("store room-ish keys:", Object.keys(f.store).filter(k => /room|Room|member|Member/i.test(k)).slice(0, 40).join(","));
f.store.close();
