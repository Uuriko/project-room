import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readCaptures, renderGallery, selectJourneys, buildReviewPacket, renderReviewPrompt, compareGalleries } from "../scripts/design-evidence-gallery.mjs";

test("gallery binds screenshot bytes, preserves failed test status and refuses unsafe paths", t => {
  const dir = mkdtempSync(join(tmpdir(), "design-gallery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic bytes for integrity unit test");
  const item = { id: "login-390", screenshot: "login-390.png", viewport: { width: 390, height: 844 },
    sha256: createHash("sha256").update(bytes).digest("hex"), accessibility: { serious: [], other: [] } };
  const save = data => writeFileSync(join(dir, "login-390.json"), JSON.stringify(data));
  save(item); writeFileSync(join(dir, item.screenshot), bytes);
  assert.equal(readCaptures(dir, { status: 1, script: "scripts/test.mjs" }, "journey-1")[0].testPassed, false);
  save({ ...item, screenshot: "../outside.png" });
  assert.throws(() => readCaptures(dir, { status: 0 }, "journey-1"), /Invalid capture/);
  save(item); writeFileSync(join(dir, item.screenshot), "changed");
  assert.throws(() => readCaptures(dir, { status: 0 }, "journey-1"), /digest mismatch/);
});

test("gallery escapes fixture labels and keeps coverage and failure limitations visible", () => {
  const html = renderGallery({ source: { commit: "a".repeat(40), tree: "b".repeat(40), dirty: false }, environment: { node: "24", playwright: "test", platform: "test" },
    runs: [{ script: "scripts/test.mjs", status: 1, durationMs: 1, captureCount: 1, log: "journey-1.log" }],
    captures: [{ id: "login-390", title: '<script>alert("x")</script>', fixture: "Synthetic & local", component: "form", testName: "real test", script: "scripts/test.mjs",
      viewport: { width: 390, height: 844 }, testPassed: false, accessibility: { serious: [{ id: "contrast" }], other: [] }, sha256: "c".repeat(64), screenshot: "journey-1/login-390.png" }] });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /capture alone is not a pass/);
  assert.match(html, /real Google\/email delivery/);
  assert.match(html, /real-provider sign-in proof/);
  assert.match(html, /Source stable during capture: NO/);
  assert.match(html, /Capture checks: NOT passed/);
  assert.match(html, /explicit dark and light themes/);
  assert.match(html, /Image framing/);
});


test("a selected design journey avoids unrelated captures and unknown names fail closed", () => {
  const selected=selectJourneys("entry");assert.equal(selected.length,1);
  assert.equal(selected[0].script,"scripts/a11y-login-browser-check.mjs");
  assert.ok(selectJourneys().length>1);assert.throws(()=>selectJourneys("../unknown"),/Unknown journey/);
});

test("agent review context retains failed and missing evidence without inventing design approval", () => {
  const report={passed:false,sourceStable:false,source:{commit:"a".repeat(40),tree:"b".repeat(40),dirty:true,filesSha256:"c".repeat(64),files:[{path:"not-needed-in-context"}]},
    generatedAt:"2026-11-12T00:00:00Z",environment:{platform:"test"},
    runs:[{id:"entry",script:"test",status:1,captureCount:0,log:"entry.log"}],captures:[]};
  const packet=buildReviewPacket(report);
  assert.equal(packet.reviewStatus,"not_reviewed");assert.equal(packet.designDecision,null);
  assert.equal(packet.captureChecksPassed,false);assert.equal(packet.sourceStable,false);
  assert.equal(packet.runs[0].status,1);assert.equal(packet.runs[0].captures,0);
  assert.equal(packet.source.files,undefined);assert.doesNotMatch(JSON.stringify(packet),/not-needed-in-context/);
  assert.match(renderReviewPrompt(packet),/insufficient evidence/);
  assert.match(renderReviewPrompt(packet),/Capture checks passed: false/);
  assert.match(renderReviewPrompt(packet),/Screenshots cannot establish/);
});


function comparisonFixture(t) {
  const root=mkdtempSync(join(tmpdir(),"design-pair-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from("synthetic screenshot bytes"),sha256=createHash("sha256").update(bytes).digest("hex");
  const capture={id:"task-dark",title:"<script>untrusted</script>",fixture:"Synthetic task",component:"task",script:"task.mjs",testName:"task",viewport:{width:390,height:844},theme:{declared:"dark"},fullPage:true,browserVersion:"test",screenshot:"task-dark.png",sha256,testPassed:true,accessibility:{serious:[],other:[]}};
  const report={version:1,source:{commit:"a".repeat(40),tree:"b".repeat(40),dirty:false},sourceStable:true,passed:true,environment:{platform:"test"},runs:[{status:0}],captures:[capture]};
  function save(side,change={}) {const dir=join(root,side);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,"manifest.json"),JSON.stringify({...report,...change}));writeFileSync(join(dir,"task-dark.png"),bytes);return dir;}
  return {root,capture,report,save};
}

test("paired review preserves sources, missing states and escaped labels without approving design",t=>{
 const f=comparisonFixture(t),baseline=f.save("before"),candidate=f.save("after",{source:{...f.report.source,commit:"c".repeat(40)},captures:[f.capture,{...f.capture,id:"new-state"}]} );
 const result=compareGalleries(baseline,candidate,join(f.root,"out"));
 assert.equal(result.pairs.length,1);assert.equal(result.pairs[0].comparable,true);
 assert.deepEqual(result.unmatched,[{id:"new-state",missingFrom:"baseline"}]);
 assert.equal(result.designDecision,null);assert.equal(result.reviewStatus,"not_reviewed");
 const html=readFileSync(join(f.root,"out/index.html"),"utf8");assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
 assert.equal(result.pairs[0].imageBytesChanged,false);
 assert.throws(()=>compareGalleries(baseline,candidate,join(f.root,"out")),/new or empty/);
});

test("paired review makes changed fixtures, environments and failed or unstable captures noncomparable",t=>{
 const f=comparisonFixture(t),baseline=f.save("before"),candidate=f.save("after",{passed:false,sourceStable:false,environment:{platform:"different"},captures:[{...f.capture,fixture:"Different task",testPassed:false}]});
 const pair=compareGalleries(baseline,candidate,join(f.root,"out")).pairs[0];
 assert.equal(pair.comparable,false);for(const reason of ["different_or_unknown_fixture","different_environment","candidate_source_unstable_or_unknown","candidate_capture_checks_not_passed"])assert.ok(pair.reasons.includes(reason));
});

test("paired review rejects tampered screenshot bytes and paths outside the evidence directory",t=>{
 const f=comparisonFixture(t),baseline=f.save("before"),candidate=f.save("after");
 writeFileSync(join(candidate,"task-dark.png"),"tampered");
 assert.throws(()=>compareGalleries(baseline,candidate,join(f.root,"out")),/digest mismatch/);
 writeFileSync(join(f.root,"outside.png"),"outside");
 f.save("after",{captures:[{...f.capture,screenshot:"../outside.png"}]});
 assert.throws(()=>compareGalleries(baseline,candidate,join(f.root,"out")),/Unsafe/);
});
