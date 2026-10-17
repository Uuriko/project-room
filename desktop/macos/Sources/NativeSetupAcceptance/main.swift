import Foundation
import Darwin
import AppKit
#if DEBUG
@testable import ProjectRoomKit
#else
import ProjectRoomKit
#endif

@main struct Acceptance {
    @MainActor static func main() async throws {
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
        parent.endSheet(sheet); parent.close()
        #endif
        print("NATIVE_SETUP_ACCEPTANCE_OK")
    }
}
