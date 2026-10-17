import Foundation
import Darwin
import AppKit
#if DEBUG
@testable import ProjectRoomKit
#else
import ProjectRoomKit
#endif

@main struct Acceptance {
    @MainActor static func main() {
        _ = NSApplication.shared
        Task { @MainActor in
            do { try await run(); exit(0) }
            catch { fputs("FAIL: \(error)\n", stderr); exit(1) }
        }
        NSApp.run()
    }
    @MainActor static func run() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("room-native-setup-\(UUID())")
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: root) }
        let script = root.appendingPathComponent("setup.mjs")
        try """
        let input='';for await(const chunk of process.stdin)input+=chunk;
        const request=JSON.parse(input),emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
        if(process.argv.length!==2||process.env.ROOM_AGENT_TOKEN)process.exit(9);
        if(request.mode==='cancel'){
          process.on('SIGTERM',()=>{emit({status:'cancelled'});process.exit(0)});
          emit({status:'waiting',pid:process.pid});setInterval(()=>{},100);
        }else if(request.mode==='bad'){process.stdout.write('not-json\\n');}
        else {emit({status:'first'});emit({status:'second',received:request.value});}
        """.write(to: script, atomically: true, encoding: .utf8)
        let node = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        guard fm.isExecutableFile(atPath: node.path) else { throw NSError(domain: "Acceptance", code: 1) }
        func check(_ condition: Bool, _ label: String) {
            guard condition else { fputs("FAIL: \(label)\n", stderr); exit(1) }; print("PASS: \(label)")
        }
        let runner = NativeSetupProcess()
        var events: [[String: Any]] = []
        func execute(_ input: [String: Any], event: @escaping ([String: Any]) -> Void) async throws -> Bool {
            try await withCheckedThrowingContinuation { continuation in
                do { try runner.start(node: node, script: script, input: input, onEvent: event, onFinish: { continuation.resume(returning: $0) }) }
                catch { continuation.resume(throwing: error) }
            }
        }
        let completed = try await execute(["value": "fixture-only"], event: { events.append($0) })
        check(completed, "native setup process completes")
        check(events.compactMap { $0["status"] as? String } == ["first", "second"], "native setup events arrive before completion in order")
        check(events.last?["received"] as? String == "fixture-only", "structured input arrives through stdin")
        check(!runner.isRunning, "native setup ownership cleared after exit")
        var pid: Int32 = 0
        let cancelled = try await execute(["mode": "cancel"], event: { event in
            if event["status"] as? String == "waiting" { pid = (event["pid"] as? NSNumber)?.int32Value ?? 0; runner.cancel() }
        })
        check(cancelled && pid > 0 && kill(pid, 0) != 0, "cancel waits for owned setup child to exit")
        let malformed = try await execute(["mode": "bad"], event: { _ in check(false, "malformed event rejected") })
        check(!malformed, "malformed setup output is refused")
        #if DEBUG
        _ = NSApplication.shared
        let host = try LocalRoomHost(directory: root.appendingPathComponent("host"))
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 760), styleMask: [.titled], backing: .buffered, defer: false)
        let setup = LocalRoomHostSetupWindow(host: host, completion: {})
        parent.makeKeyAndOrderFront(nil)
        setup.show(on: parent)
        try await Task.sleep(nanoseconds: 200_000_000)
        guard let sheet = parent.attachedSheet, let content = sheet.contentView else { throw NSError(domain: "Acceptance", code: 2) }
        content.layoutSubtreeIfNeeded()
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let controls = descendants(content)
        let advanced = controls.compactMap { $0 as? NSButton }.first { $0.title == "Advanced setup" }!
        let workspaceLabel = controls.compactMap { $0 as? NSTextField }.first { $0.stringValue == "Workspace" }!
        let nodeLabel = controls.compactMap { $0 as? NSTextField }.first { $0.stringValue == "Node executable" }!
        check(!workspaceLabel.isHiddenOrHasHiddenAncestor && nodeLabel.isHiddenOrHasHiddenAncestor, "ordinary setup shows workspace and hides runtime paths")
        advanced.performClick(nil)
        check(!nodeLabel.isHiddenOrHasHiddenAncestor, "advanced runtime selection remains available")
        advanced.performClick(nil)
        content.layoutSubtreeIfNeeded()
        // Exercise the actual sheet and subprocess bridge through a room switch.
        // No production invitation, credentials or provider calls are involved.
        let helper = root.appendingPathComponent("native-agent-setup.mjs")
        try """
        let input='';for await(const chunk of process.stdin)input+=chunk;
        const request=JSON.parse(input);
        const result=request.target.endsWith('/a')?{status:'connected',roomId:'a',configDirectory:'/fixture/room-a'}:
          request.target.endsWith('/preview')?{status:'approval_required',roomId:'preview',permissions:[],expectedPreview:'fixture'}:
          {status:'admission_pending'};
        process.stdout.write(JSON.stringify(result)+'\\n');
        """.write(to: helper, atomically: true, encoding: .utf8)
        func field(_ name: String) -> NSTextField {
            controls.compactMap { $0 as? NSTextField }.first { $0.placeholderString == name }!
        }
        let targetField = field("Paste a room or invitation link")
        let connectionField = field("Room connection folder")
        field("Node executable").stringValue = node.path
        field("Room host script").stringValue = root.appendingPathComponent("run-codex-room.mjs").path
        let connect = controls.compactMap { $0 as? NSButton }.first { $0.title == "Connect room" }!
        func enter(_ link: String) {
            targetField.stringValue = link
            NotificationCenter.default.post(name: NSControl.textDidChangeNotification, object: targetField)
        }
        func connectAndWait() async throws {
            connect.performClick(nil)
            for _ in 0..<100 {
                if connect.isEnabled { return }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            throw NSError(domain: "SetupDidNotFinish", code: 1)
        }
        enter("https://example.test/a"); try await connectAndWait()
        check(connectionField.stringValue == "/fixture/room-a", "successful room enrollment populates the selected connection")
        enter("https://example.test/b")
        check(connectionField.stringValue.isEmpty, "editing the room link invalidates the previous connection before Save")
        try await connectAndWait()
        check(connectionField.stringValue.isEmpty, "pending room admission cannot reuse a different room connection")
        enter("https://example.test/preview"); try await connectAndWait()
        check(connect.title == "Accept invitation", "invitation preview offers acceptance")
        enter("https://example.test/a")
        check(connect.title == "Connect room", "changing an invitation discards its previous acceptance state")
        try await connectAndWait()
        check(connectionField.stringValue == "/fixture/room-a", "reconnecting succeeds after a pending room switch")
        // A subsequent failed check must not silently fall back to the old room.
        try "process.exit(1)".write(to: helper, atomically: true, encoding: .utf8)
        try await connectAndWait()
        check(connectionField.stringValue.isEmpty, "failed reconnect cannot save a stale room connection")
        withExtendedLifetime(setup) {}
        parent.endSheet(sheet); parent.close()
        #endif
        print("NATIVE_SETUP_ACCEPTANCE_OK")
    }
}
