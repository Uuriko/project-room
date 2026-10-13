import AppKit
import WebKit

@MainActor final class PanelAcceptance: NSObject, NSApplicationDelegate {
    var room: RoomWindow!
    var bar: RoomMenuBar!
    func applicationDidFinishLaunching(_ notification: Notification) {
        room = RoomWindow(url:URL(string:"http://127.0.0.1:59999")!,isolated:true)
        let html = """
        <article data-assistant-run="run1"><strong>Review layout</strong><p>Working</p><button data-pause-run="run1" data-cancel="true" data-revision="2" onclick="window.stopped=true">Stop</button></article><h1 id="room-title">Test room</h1><form id="message-form"><select id="message-to-select"><option value="">Everyone</option><option value="alice">Alice</option></select><textarea id="message-input" placeholder="Message #general"></textarea><button type="submit">Send</button></form><button id="ask-room" aria-pressed="false">Ask Room</button><div id="composer-attachments"></div><span id="activity-preview-count">2</span><button id="activity-preview-open">Activity</button><script>window.sent=[];document.querySelector('#message-form').onsubmit=e=>{e.preventDefault();sent.push(document.querySelector('#message-input').value);document.querySelector('#message-input').value='';};document.querySelector('#ask-room').onclick=e=>e.target.setAttribute('aria-pressed','true');</script>
        """
        room.webView.loadHTMLString(html,baseURL:URL(string:"http://127.0.0.1:59999")!)
        Task {
            do {
                for _ in 0..<100 {
                    if (try? await room.webView.evaluateJavaScript("!!document.querySelector('#message-form')")) as? Bool == true { break }
                    try await Task.sleep(nanoseconds:20_000_000)
                }
                let root = URL(fileURLWithPath:"/tmp").appendingPathComponent("pr-p-" + UUID().uuidString)
                let suite = "pr-persist-" + UUID().uuidString
                let prefs = UserDefaults(suiteName:suite)!
                defer { prefs.removePersistentDomain(forName:suite); try? FileManager.default.removeItem(at:root) }
                prefs.set(true,forKey:LocalToolsWindow.enabledPreference)
                let first = try LocalToolsWindow(service:LocalTools(directory:root),preferences:prefs)
                precondition(first.toolStatus["enabled"] as? Bool == true)
                first.stop()
                precondition(prefs.bool(forKey:LocalToolsWindow.enabledPreference))
                let second = try LocalToolsWindow(service:LocalTools(directory:root),preferences:prefs)
                precondition(second.toolStatus["enabled"] as? Bool == true)
                second.pause(); second.stop()
                let third = try LocalToolsWindow(service:LocalTools(directory:root),preferences:prefs)
                precondition(third.toolStatus["enabled"] as? Bool == false)
                try third.resume()
                precondition(third.toolStatus["enabled"] as? Bool == true)
                precondition(prefs.bool(forKey:LocalToolsWindow.enabledPreference))
                let resumedRevision = third.toolStatus["grantRevision"] as! Int
                try third.resume()
                precondition(third.toolStatus["grantRevision"] as? Int == resumedRevision)
                third.pause(); third.stop()
                print("PASS persistent access: enable survives shutdown/restart, pause survives restart")
                let snapshot = try await room.menuSnapshot()
                precondition(snapshot["ready"] as? Bool == true)
                let context = snapshot["context"] as! String
                precondition(snapshot["attention"] as? Int == 2)
                let staleStop = try await room.menuStopRun("run1",revision:"1",context:context)
                precondition(!staleStop)
                let currentStop = try await room.menuStopRun("run1",revision:"2",context:context)
                precondition(currentStop)
                let stopped = try await room.webView.evaluateJavaScript("window.stopped") as? Bool
                precondition(stopped == true)
                let result = try await room.menuPrompt("Review \"this\"\n<literal>",context:context)
                precondition(result.isEmpty)
                let sent = try await room.webView.evaluateJavaScript("sent") as! [String]
                precondition(sent == ["Review \"this\"\n<literal>"])
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#message-input').value='preserve me'")
                let draft = try await room.menuPrompt("must not replace",context:context)
                precondition(draft.contains("draft"))
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#message-to-select').value='alice'")
                let changed = try await room.menuPrompt("must not send",context:context)
                precondition(changed.contains("changed"))
                bar = RoomMenuBar(room:room)
                await bar.refresh()
                precondition(bar.model.attention == 2 && !bar.model.enabled)
                bar.model.draft = "persistent draft"
                bar.toggle(); bar.close(); bar.toggle()
                precondition(bar.model.draft == "persistent draft")
                let view = bar.popover.contentViewController!.view
                view.setFrameSize(NSSize(width:376,height:340))
                view.layoutSubtreeIfNeeded()
                if let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds) {
                    view.cacheDisplay(in:view.bounds,to:bitmap)
                    try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:"/tmp/project-room-menu-panel.png"))
                }
                bar.close()
                print("PASS panel: destination, literal prompt, draft protection, changed-recipient refusal, real WebKit handoff, attention, popover draft preservation")
                exit(0)
            } catch { print("FAIL \(error)"); exit(1) }
        }
    }
}
@main struct MenuAcceptanceMain {
    @MainActor static func main() {
        let app=NSApplication.shared; app.setActivationPolicy(.regular)
        let delegate=PanelAcceptance(); app.delegate=delegate; app.run()
    }
}
