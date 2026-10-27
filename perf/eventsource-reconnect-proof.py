# Real-EventSource reconnect proof for #5082 (room seq 20279).
# Usage: python3 perf/eventsource-reconnect-proof.py <repo worktree> <scratch dir> <label>
# Needs Python playwright + Chromium, Node 24 at ~/n24/node_modules/.bin/node (edit NODE below).
# Swap src/client.js between the base and the fix and run once per label; compare the JSON lines.
import sys, subprocess, time, os, json, re, shutil
from playwright.sync_api import sync_playwright
WT, SP, label = sys.argv[1], sys.argv[2], sys.argv[3]
PORT=4791; B=f"http://127.0.0.1:{PORT}"; NODE=os.path.expanduser("~/n24/node_modules/.bin/node")
db=f"{SP}/esdb-{label}"; shutil.rmtree(db, ignore_errors=True); os.makedirs(db)
env=dict(os.environ, PORT=str(PORT), HOST="127.0.0.1", ROOM_ORIGIN=B, ROOM_DB=f"{db}/room.db")
def start():
  p=subprocess.Popen([NODE,"server.mjs"],cwd=WT,env=env,stdout=open(f"{SP}/es-{label}.log","a"),stderr=subprocess.STDOUT)
  for _ in range(100):
    try:
      import urllib.request; urllib.request.urlopen(B+"/api/health",timeout=1); return p
    except Exception: time.sleep(0.2)
  raise SystemExit("server did not start")
def stop(p): p.terminate(); p.wait(10)
reads=[]
def is_read(u):
  path=u.split("127.0.0.1:%d"%PORT)[-1]
  return re.match(r"^/api/rooms/[^/?]+(\?.*)?$", path) is not None
out={"variant":label}
srv=start()
with sync_playwright() as pw:
  br=pw.chromium.launch(); ctx=br.new_context(); pg=ctx.new_page()
  pg.on("request", lambda r: r.method=="GET" and is_read(r.url) and reads.append((time.time(), r.url)))
  pg.goto(B+"/",wait_until="networkidle")
  pg.get_by_role("button",name="Create account").click(); pg.wait_for_timeout(300)
  pg.fill("input[type=email]:visible","es.proof@example.com"); pg.fill("input[type=password]:visible","Correct-Horse-Battery-77!")
  pg.locator("button:visible",has_text="Create account").last.click()
  pg.wait_for_selector("textarea:visible",timeout=20000); pg.wait_for_timeout(2500)
  # Scenario 1: server gone for 10 s (browser native retry runs), then back.
  reads.clear(); stop(srv); t0=time.time(); pg.wait_for_timeout(10000)
  out["s1_reads_during_outage"]=len(reads)
  srv=start(); t1=time.time(); pg.wait_for_timeout(8000)
  out["s1_reads_after_back"]=len([r for r in reads if r[0]>=t1])
  out["s1_status"]=pg.evaluate("document.querySelector('#connection-status')?.textContent?.trim()||''")[:80]
  pg.locator("textarea:visible").first.fill("after reconnect"); pg.keyboard.press("Enter"); pg.wait_for_timeout(1500)
  out["s1_post_ok"]="after reconnect" in pg.inner_text("body")
  # Scenario 2: drop the server, revoke the session while the browser is away, bring it back.
  stop(srv); pg.wait_for_timeout(3000); srv=start()
  sess=pg.evaluate("""async()=>{const r=await fetch('/api/account-session',{credentials:'same-origin'});const s=await r.json();
    const h={};const c=s.csrf??s.session?.csrf;const b=s.sessionBinding??s.session?.sessionBinding; if(c)h['X-CSRF-Token']=c; if(b)h['X-Session-Binding']=b;
    h['Content-Type']='application/json';const d=await fetch('/api/account-session',{method:'DELETE',credentials:'same-origin',headers:h,body:JSON.stringify({expectedSessionRevision:s.sessionRevision})});return {get:r.status,del:d.status,keys:Object.keys(s)}}""")
  out["s2_revoke"]=sess
  reads.clear(); t2=time.time(); pg.wait_for_timeout(10000)
  out["s2_reads_after_revoke"]=len(reads)
  out["s2_signed_out_ui"]=pg.evaluate("!document.querySelector('#auth-panel')?.hidden && document.querySelector('#main')?.hidden===true")
  br.close()
stop(srv)
print(json.dumps(out))
