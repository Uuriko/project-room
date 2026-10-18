import Foundation
final class Expectation { let semaphore = DispatchSemaphore(value:0); func fulfill() { semaphore.signal() } }
func failCheck(_ message: String) { fputs("FAILED: \(message)\n", stderr); exit(1) }
func expectEqual<T: Equatable>(_ actual: T, _ expected: T) { if actual != expected { failCheck("\(actual) != \(expected)") } }
func expectFalse(_ value: Bool) { if value { failCheck("Expected false") } }
func expectError(_ expression: @autoclosure () throws -> Any, _ handler: (Error) -> Void) { do { _ = try expression(); failCheck("Expected refusal") } catch { handler(error) } }
import ProjectRoomKit
import ApplicationServices
import CoreGraphics
import AppKit

final class FixtureObservation: LocalComputerObserving {
    var reads = 0
    var beforeReturn: (() -> Void)?
    func appState(processID: Int32?) throws -> [String: Any] { reads += 1; beforeReturn?(); return ["processId": processID ?? 1, "tree": LocalComputerObservation.fields(role: "AXTextField", subrole: "AXSecureTextField", title: "secret", value: "password")] }
    func screenshot(windowID: UInt32) throws -> LocalScreenshot {
        reads += 1; beforeReturn?()
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=")!
        return LocalScreenshot(png: png, width: 1, height: 1, windowID: windowID)
    }
}

final class InputButtonFixture: NSButton {
    var rightClicks = 0
    override func rightMouseDown(with event: NSEvent) { rightClicks += 1 }
}

final class InputClickFixture: NSObject { var count = 0; @objc func click() { count += 1 } }

final class InputFixtureWindow: NSWindow { override var canBecomeKey: Bool { true }; override var canBecomeMain: Bool { true } }

final class FixtureInput: LocalComputerActing {
    var writes = 0
    var beforeDispatch: (() -> Void)?
    func perform(_ arguments: [String: Any], authorize: () throws -> Void) throws -> [String: Any] {
        beforeDispatch?(); try authorize(); writes += 1
        return ["state": "input_dispatched"]
    }
}

final class LocalToolsTests {
    var teardown: [() -> Void] = []
    func addTeardownBlock(_ action: @escaping () -> Void) { teardown.append(action) }
    func expectation(description: String) -> Expectation { Expectation() }
    func wait(for values: [Expectation], timeout: Double) { for value in values { expectEqual(value.semaphore.wait(timeout: .now() + timeout), .success) } }
    private func fixture() throws -> (URL, LocalTools) {
        // Short socket path; exclusively synthetic data, never operator resources.
        let root = URL(fileURLWithPath: "/tmp/pr-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        addTeardownBlock { try? FileManager.default.removeItem(at:root) }
        return (root, try LocalTools(directory:root.appendingPathComponent("broker"),fixtureRoot:root))
    }
    private func refusal(_ code: String, _ action: () throws -> Any) {
        expectError(try action()) { expectEqual(($0 as? LocalToolFailure)?.code,code) }
    }
    func testCapabilityReadiness() throws {
        // Independent permission combinations matter: screenshots must not
        // block file work or input, and AX access must not imply screen access.
        for enabled in [false, true] {
            for accessibility in [false, true] {
                for screen in [false, true] {
                    let entries = LocalToolReadiness.capabilities(enabled: enabled, accessibility: accessibility, screenCapture: screen)
                    expectEqual(entries.count, 4)
                    let byID = Dictionary(uniqueKeysWithValues: entries.map { ($0["id"] as! String, $0) })
                    let expected = ["files_and_processes": enabled, "app_state": enabled && accessibility,
                                    "screenshots": enabled && screen, "app_input": enabled && accessibility]
                    for (id, passed) in expected {
                        expectEqual(byID[id]!["state"] as? String, passed ? "preflight_passed" : "blocked")
                        let blockers = byID[id]!["blockers"] as! [String]
                        expectEqual(blockers.contains("mac_tools_paused"), !enabled)
                        expectEqual(blockers.isEmpty, passed)
                        if !enabled { expectEqual(byID[id]!["message"] as? String, "Enable local tools") }
                    }
                    expectEqual((byID["screenshots"]!["blockers"] as! [String]).contains("screen_capture_permission_required"), !screen)
                    expectEqual((byID["app_input"]!["blockers"] as! [String]).contains("accessibility_permission_required"), !accessibility)
                    expectEqual(LocalToolReadiness.summary(entries).split(separator: "\n").count, 4)
                }
            }
        }
        let (_, tools) = try fixture()
        let connection = try LocalToolConnection(service: tools)
        defer { connection.stop() }
        for enabled in [false, true, false] {
            let revision = tools.setEnabled(enabled); try connection.publish()
            let status = try LocalToolConnection.call(connectionURL: connection.connectionURL, name: "mac_status", arguments: [:])
            expectEqual(status["readinessScope"] as? String, "local_preflight_only")
            expectEqual(status["grantRevision"] as? Int, revision)
            let entries = status["capabilities"] as! [[String: Any]]
            expectEqual(entries.first!["state"] as? String, enabled ? "preflight_passed" : "blocked")
            expectEqual((entries.flatMap { $0["tools"] as! [String] }).count, 7)
            // Polling readiness cannot start a process, observe app contents or capture a window.
            expectEqual(status["runningProcesses"] as? Int, 0)
        }
    }
    func testConnectedReadiness() throws {
        let connection = "/fixture/private-connection.json"
        let local: [String: Any] = ["enabled": true, "capabilities": LocalToolReadiness.capabilities(enabled: true, accessibility: true, screenCapture: true)]
        let base: [String: Any] = ["configured": true, "running": true, "statusFresh": true,
            "phase": "watching_room", "credentials": "present", "protocol": "qualified", "macTools": ["mode": "control", "connection": connection]]
        func notice(_ changes: [String: Any], _ state: [String: Any]? = nil) -> String? {
            LocalHostReadiness.notice(host: base.merging(changes) { _, new in new }, local: state ?? local, connection: connection)
        }
        expectEqual(notice([:]), nil)
        for (change, fragment) in [
            (["configured": false], "Set up"), (["running": false], "stopped"), (["stopping": true], "stopping"),
            (["running": false, "lastExit": "unconfirmed"], "without a confirmed stop"),
            (["statusFresh": false, "credentials": "present"], "unavailable"),
            (["credentials": "login_required"], "sign-in"), (["credentials": "unknown"], "checking"),
            (["phase": "retrying_room"], "reconnecting"), (["phase": "recovery_pending"], "reconciling"),
            (["phase": "new_unknown_phase"], "checking"), (["protocol": "unverified"], "checking"),
            (["macTools": ["mode": "none"]], "connect Mac tools"),
            (["macTools": ["mode": "control", "connection": "/different"]], "different Mac tool connection"),
            (["macTools": ["mode": "approval_required", "connection": connection]], "needs approval")
        ] as [([String: Any], String)] { expectEqual(notice(change)?.contains(fragment), true) }
        expectEqual(notice([:], ["enabled": false])?.contains("paused"), true)
        let noScreen: [String: Any] = ["enabled": true, "capabilities": LocalToolReadiness.capabilities(enabled: true, accessibility: true, screenCapture: false)]
        expectEqual(notice([:], noScreen)?.contains("Screen Recording"), true)
        let (root, _) = try fixture(), config = root.appendingPathComponent("runtime.json")
        for (body, mode) in [("{}", "none"), ("invalid", "unknown"),
            ("{\"macTools\":{\"command\":\"/tool\",\"connection\":\"/private\",\"inputApproval\":\"approve\"}}", "control"),
            ("{\"macTools\":{\"command\":\"/tool\",\"connection\":\"/private\"}}", "approval_required") ] {
            try body.write(to: config, atomically: true, encoding: .utf8)
            expectEqual(LocalHostReadiness.toolConfiguration(config)["mode"], mode)
        }
    }
    @MainActor func testReadinessWindow() throws {
        _ = NSApplication.shared
        let (root, tools) = try fixture()
        let host = try LocalRoomHost(directory: root.appendingPathComponent("host"))
        let panel = try LocalToolsWindow(service: tools, host: host)
        var delivered: [String?] = []
        panel.onReadinessChange = { delivered.append($0) }
        expectEqual(delivered.last??.contains("Set up"), true)
        defer { panel.stop(); panel.window.orderOut(nil) }
        let content = panel.window.contentView!
        func descendants(_ view: NSView) -> [NSView] { view.subviews.flatMap { [$0] + descendants($0) } }
        let controls = descendants(content).compactMap { $0 as? NSButton }
        let enable = controls.first { $0.title == "Enable local tools" }!
        let advanced = controls.first { $0.title == "Advanced" }!
        let manual = controls.filter { ["Copy agent connection", "Import existing host configuration…"].contains($0.title) }
        expectEqual(manual.count, 2)
        expectEqual(manual.allSatisfy { $0.isHiddenOrHasHiddenAncestor }, true)
        advanced.performClick(nil)
        expectEqual(manual.allSatisfy { !$0.isHiddenOrHasHiddenAncestor }, true)
        content.layoutSubtreeIfNeeded()
        for view in manual { expectEqual(content.bounds.contains(content.convert(view.bounds, from: view)), true) }
        advanced.performClick(nil)
        expectEqual(manual.allSatisfy { $0.isHiddenOrHasHiddenAncestor }, true)

        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            panel.window.appearance = NSAppearance(named: appearance)
            panel.window.orderFrontRegardless()
            for enabled in [false, true] {
                if tools.status()["enabled"] as? Bool != enabled { enable.performClick(nil) }
                content.layoutSubtreeIfNeeded()
                panel.window.display()
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
                let labels = descendants(content).compactMap { $0 as? NSTextField }
                let expected = LocalToolReadiness.summary(tools.status()["capabilities"] as! [[String: Any]])
                expectEqual(labels.contains { $0.stringValue.hasPrefix(expected) }, true)
                for view in (labels + controls).filter({ !$0.isHiddenOrHasHiddenAncestor }) {
                    let frame = content.convert(view.bounds, from: view)
                    expectEqual(content.bounds.insetBy(dx: -1, dy: -1).contains(frame), true)
                }
                if let destination = ProcessInfo.processInfo.environment["ROOM_READINESS_QA_OUTPUT"] {
                    let path = URL(fileURLWithPath: destination).appendingPathComponent("readiness-\(appearance.rawValue)-\(enabled).png")
                    let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                    capture.arguments = ["-x", "-o", "-l", String(panel.window.windowNumber), path.path]
                    try capture.run(); capture.waitUntilExit(); expectEqual(capture.terminationStatus, 0)
                }
            }
        }
        let room = RoomWindow(url: URL(string: "http://127.0.0.1:1")!, isolated: true, acceptanceLocalToolsFactory: { panel })
        defer { room.stopLocalTools(); room.window.orderOut(nil) }
        // This fixture checks native chrome, not the navigation policy covered
        // by RoomAcceptance. Permit its in-memory document without a server.
        room.webView.stopLoading(); room.webView.navigationDelegate = nil
        room.webView.loadHTMLString("<html><body style='font:18px system-ui;padding:24px'><h1>Conversation</h1><p>Synthetic room fixture. No account or room connection.</p></body></html>", baseURL: room.origin)
        room.showMyMac(); panel.window.orderOut(nil)
        let roomContent = room.window.contentView!
        let open = descendants(roomContent).compactMap { $0 as? NSButton }.first { $0.title == "Open My Mac" }!
        expectEqual(open.isHiddenOrHasHiddenAncestor, false)
        open.performClick(nil); expectEqual(panel.window.isVisible, true); panel.window.orderOut(nil)
        let longNotice = "This agent uses a different Mac tool connection. Stop it and reconnect tools in My Mac."
        room.updateLocalAgentNotice(longNotice)
        for width in [480, 1200] {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                room.window.appearance = NSAppearance(named: appearance)
                room.window.setContentSize(NSSize(width: width, height: 700)); room.window.orderFrontRegardless()
                roomContent.layoutSubtreeIfNeeded(); room.window.display()
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
                let label = descendants(roomContent).compactMap { $0 as? NSTextField }.first { $0.stringValue == longNotice }!
                expectEqual(roomContent.bounds.contains(roomContent.convert(label.bounds, from: label)), true)
                expectEqual(roomContent.bounds.contains(roomContent.convert(open.bounds, from: open)), true)
                if let destination = ProcessInfo.processInfo.environment["ROOM_READINESS_QA_OUTPUT"] {
                    let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                    capture.arguments = ["-x", "-o", "-l", String(room.window.windowNumber), URL(fileURLWithPath: destination).appendingPathComponent("conversation-\(width)-\(appearance.rawValue).png").path]
                    try capture.run(); capture.waitUntilExit(); expectEqual(capture.terminationStatus, 0)
                }
            }
        }
        room.updateLocalAgentNotice(nil)
        expectEqual(open.isHiddenOrHasHiddenAncestor, true)
    }
    func testComputerObservations() throws {
        let (root, _) = try fixture(); let provider = FixtureObservation()
        let tools = try LocalTools(directory: root.appendingPathComponent("observations"), fixtureRoot: root, observations: provider)
        refusal("mac_tools_paused") { try tools.call("mac_app_state", arguments: [:], grantRevision: 0) }
        expectEqual(provider.reads, 0)
        let revision = tools.setEnabled(true)
        refusal("invalid_tool_arguments") { try tools.call("mac_screenshot", arguments: ["windowId": true], grantRevision: revision) }
        refusal("mac_grant_changed") { try tools.call("mac_app_state", arguments: [:], grantRevision: 0) }
        let state = try tools.call("mac_app_state", arguments: ["processId": 1], grantRevision: revision)
        let secure = state["tree"] as! [String: Any]
        expectEqual(secure["redacted"] as? Bool, true); expectEqual(secure["value"] as? String, nil); expectEqual(secure["title"] as? String, nil)
        let bounded = LocalComputerObservation.fields(role: "AXStaticText", subrole: nil, title: nil, value: String(repeating: "x", count: 2000))
        expectEqual((bounded["value"] as! String).count, 512)
        let connection = try LocalToolConnection(service: tools)
        let shot = try LocalToolConnection.call(connectionURL: connection.connectionURL, name: "mac_screenshot", arguments: ["windowId": 42])
        expectEqual(shot["uploaded"] as? Bool, false); expectEqual(shot["width"] as? Int, 1)
        let path = shot["path"] as! String
        expectEqual(try Data(contentsOf: URL(fileURLWithPath: path)).count, shot["bytes"] as! Int)
        expectEqual((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let captureDirectory = URL(fileURLWithPath: path).deletingLastPathComponent()
        let unrelated = captureDirectory.appendingPathComponent("capture-personal.png")
        try Data("preserve unrelated file".utf8).write(to: unrelated)
        for _ in 0..<10 { _ = try tools.call("mac_screenshot", arguments: ["windowId": 42], grantRevision: revision) }
        expectEqual(try String(contentsOf: unrelated, encoding: .utf8), "preserve unrelated file")
        expectEqual(try FileManager.default.contentsOfDirectory(atPath: captureDirectory.path).filter { $0.hasPrefix("capture-") }.count, 9)
        let count = try FileManager.default.contentsOfDirectory(atPath: captureDirectory.path).filter { $0.hasPrefix("capture-") }.count
        provider.beforeReturn = { tools.setEnabled(false) }
        refusal("mac_tools_paused") { try tools.call("mac_screenshot", arguments: ["windowId": 42], grantRevision: revision) }
        expectEqual(try FileManager.default.contentsOfDirectory(atPath: captureDirectory.path).filter { $0.hasPrefix("capture-") }.count, count)
        // Actual native permission gate, with no prompts or operator-window capture.
        if !AXIsProcessTrusted() { refusal("accessibility_permission_required") { try LocalComputerObservation().appState(processID: getpid()) } }
        else { print("SKIP actual AX read: already trusted; synthetic secure fixture covers projection") }
        if !CGPreflightScreenCaptureAccess() { refusal("screen_capture_permission_required") { try LocalComputerObservation().screenshot(windowID: 1) } }
        else { print("SKIP actual screenshot: permission present; no unrelated operator content captured") }
    }
    func testActualOwnedWindowObservation() throws {
        guard AXIsProcessTrusted(), CGPreflightScreenCaptureAccess() else { print("SKIP real fixture capture: native permission absent; no prompt requested"); return }
        let (root, _) = try fixture()
        let application = NSApplication.shared; application.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 50, y: 50, width: 320, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Project Room synthetic capture fixture"
        let secret = NSSecureTextField(); secret.stringValue = "FixtureSecretToRedactOnly"
        window.contentView = NSStackView(views: [NSTextField(labelWithString: "Synthetic acceptance window only"), secret])
        window.orderFrontRegardless()
        window.display()
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        defer { window.orderOut(nil) }
        let tools = try LocalTools(directory: root.appendingPathComponent("actual-observation"))
        _ = tools.setEnabled(true); let connection = try LocalToolConnection(service: tools)
        let mutex = NSLock(); var finished = false, failure: Error?, screenshot: [String: Any]?, state: [String: Any]?
        let windowID = window.windowNumber
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let app = try LocalToolConnection.call(connectionURL: connection.connectionURL, name: "mac_app_state", arguments: ["processId": getpid()])
                let shot = try LocalToolConnection.call(connectionURL: connection.connectionURL, name: "mac_screenshot", arguments: ["windowId": windowID])
                mutex.lock(); state = app; screenshot = shot; mutex.unlock()
            } catch { mutex.lock(); failure = error; mutex.unlock() }
            mutex.lock(); finished = true; mutex.unlock()
        }
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            mutex.lock(); let done = finished; mutex.unlock(); if done { break }
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
        mutex.lock(); let complete = finished, error = failure, shot = screenshot, app = state; mutex.unlock()
        expectEqual(complete, true); if let error { throw error }
        expectEqual(app?["processId"] as? Int32, getpid())
        expectEqual((app?["windows"] as? [[String: Any]] ?? []).contains { $0["windowId"] as? Int == windowID }, true)
        let projected = String(data: try JSONSerialization.data(withJSONObject: app!), encoding: .utf8)!
        expectFalse(projected.contains("FixtureSecretToRedactOnly"))
        expectEqual((app?["nodeCount"] as? Int ?? 0) <= 80, true)
        expectEqual(shot?["windowId"] as? Int, windowID)
        expectEqual(shot?["uploaded"] as? Bool, false)
        guard let path = shot?["path"] as? String, let bitmap = NSBitmapImageRep(data: try Data(contentsOf: URL(fileURLWithPath: path))) else { failCheck("Actual screenshot was not a PNG"); return }
        expectEqual(bitmap.pixelsWide, shot?["width"] as? Int ?? 0)
        expectEqual(bitmap.pixelsHigh, shot?["height"] as? Int ?? 0)
        expectEqual(bitmap.pixelsWide > 0 && bitmap.pixelsWide <= 2048, true)
        print("PASS actual owned-window AX and ScreenCaptureKit through authenticated native IPC")
    }


    func testActualOwnedWindowInput() throws {
        guard AXIsProcessTrusted() else { print("SKIP real input: native Accessibility permission absent"); return }
        let (root, _) = try fixture()
        let previous = NSWorkspace.shared.frontmostApplication
        let app = NSApplication.shared; app.setActivationPolicy(.regular); app.finishLaunching()
        func pump() {
            if let event = app.nextEvent(matching: .any, until: Date().addingTimeInterval(0.02), inMode: .default, dequeue: true) { app.sendEvent(event) }
            app.updateWindows()
        }
        let window = InputFixtureWindow(contentRect: NSRect(x: 300, y: 300, width: 320, height: 160), styleMask: [.titled], backing: .buffered, defer: false)
        window.title = "Project Room input acceptance fixture"
        let field = NSTextField(frame: NSRect(x: 20, y: 60, width: 280, height: 30))
        window.contentView!.addSubview(field)
        let clicks = InputClickFixture()
        let button = InputButtonFixture(frame: NSRect(x: 100, y: 15, width: 120, height: 35))
        button.title = "Fixture click"; button.target = clicks; button.action = #selector(InputClickFixture.click)
        window.contentView!.addSubview(button)
        let scroll = NSScrollView(frame: NSRect(x:20, y:100, width:280, height:50))
        scroll.hasVerticalScroller = true
        let document = NSTextView(frame:NSRect(x:0, y:0, width:260, height:1500))
        document.string = String(repeating: "Scroll fixture row\n", count:100)
        scroll.documentView = document
        window.contentView!.addSubview(scroll)
        window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true); window.makeFirstResponder(field)
        defer { window.orderOut(nil); _ = previous?.activate(options: []) }
        let tools = try LocalTools(directory: root.appendingPathComponent("real-input"))
        let revision = tools.setEnabled(true)
        let connection = try LocalToolConnection(service: tools)
        defer { connection.stop() }
        func call(_ args: [String: Any]) throws -> [String: Any] {
            let mutex = NSLock(); var done = false, result: [String: Any]?, failure: Error?
            DispatchQueue.global().async {
                do { let value = try LocalToolConnection.call(connectionURL: connection.connectionURL, name: "mac_input", arguments: args); mutex.lock(); result = value; mutex.unlock() }
                catch { mutex.lock(); failure = error; mutex.unlock() }
                mutex.lock(); done = true; mutex.unlock()
            }
            let end = Date().addingTimeInterval(5)
            while Date() < end {
                pump()
                mutex.lock(); let complete = done; mutex.unlock(); if complete { break }
            }
            mutex.lock(); defer { mutex.unlock() }
            guard done else { throw NSError(domain:"fixture_input_timeout", code:1) }
            if let failure { throw failure }; return result!
        }
        let end = Date().addingTimeInterval(2)
        while !NSRunningApplication.current.isActive && Date() < end { pump() }
        window.display()
        let shown = Date().addingTimeInterval(0.5)
        while Date() < shown { pump() }
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(field)
        window.makeKey(); pump()
        let base: [String: Any] = ["processId": getpid(), "windowId": window.windowNumber]
        expectEqual(try call(base.merging(["requestId":"actual-activate", "action":"activate"]) { _,new in new })["state"] as? String, "activation_requested")
        let args = base.merging(["requestId":"actual-type", "action":"type", "text":"Room input works"]) { _,new in new }
        expectEqual(try call(args)["state"] as? String, "input_dispatched")
        let delivered = Date().addingTimeInterval(2)
        while field.stringValue != "Room input works" && Date() < delivered { pump() }
        expectEqual(field.stringValue, "Room input works")
        expectEqual(try call(args)["duplicate"] as? Bool, true)
        _ = try call(base.merging(["requestId":"actual-backspace", "action":"key", "key":"backspace"]) { _,new in new })
        let deleted = Date().addingTimeInterval(2)
        while field.stringValue != "Room input work" && Date() < deleted { pump() }
        expectEqual(field.stringValue, "Room input work")
        refusal("computer_target_changed") { try tools.call("mac_input", arguments:base.merging(["requestId":"wrong-target", "action":"type", "text":"never", "windowId":UInt32.max]) { _,new in new }, grantRevision:revision) }
        _ = try call(base.merging(["requestId":"actual-click", "action":"click", "x":0.5, "y":0.82]) { _,new in new })
        let clicked = Date().addingTimeInterval(2)
        while clicks.count == 0 && Date() < clicked { pump() }
        expectEqual(clicks.count, 1)
        expectEqual(try call(base.merging(["requestId":"actual-click", "action":"click", "x":0.5, "y":0.82]) { _,new in new })["duplicate"] as? Bool, true)
        pump(); expectEqual(clicks.count, 1)
        _ = try call(base.merging(["requestId":"actual-right-click", "action":"click", "x":0.5, "y":0.82, "button":"right"]) { _,new in new })
        let rightClicked = Date().addingTimeInterval(2)
        while button.rightClicks == 0 && Date() < rightClicked { pump() }
        expectEqual(button.rightClicks, 1)
        let cover = NSPanel(contentRect:window.frame, styleMask:[.borderless,.nonactivatingPanel], backing:.buffered, defer:false)
        cover.level = .floating; cover.backgroundColor = .white; cover.orderFrontRegardless()
        let covered = Date().addingTimeInterval(0.2)
        while Date() < covered { pump() }
        do {
            _ = try call(base.merging(["requestId":"occluded-click", "action":"click", "x":0.5, "y":0.82]) { _,new in new })
            failCheck("Expected occluded target refusal")
        } catch { expectEqual((error as? LocalToolFailure)?.code, "computer_target_occluded") }
        cover.orderOut(nil)
        let uncovered = Date().addingTimeInterval(0.2)
        while Date() < uncovered { pump() }
        let beforeScroll = scroll.contentView.bounds.origin.y
        _ = try call(base.merging(["requestId":"actual-scroll", "action":"scroll", "x":0.5, "y":0.35, "deltaX":0, "deltaY":-80]) { _,new in new })
        let scrolled = Date().addingTimeInterval(2)
        while scroll.contentView.bounds.origin.y == beforeScroll && Date() < scrolled { pump() }
        expectFalse(scroll.contentView.bounds.origin.y == beforeScroll)
        print("PASS actual owned-window activation, typing, key/click/scroll effects, exact retry and wrong target refusal through native IPC")
    }
    func testInputRetryAndPause() throws {
        let (root, _) = try fixture(), input = FixtureInput()
        let tools = try LocalTools(directory: root.appendingPathComponent("input"), fixtureRoot: root, input: input)
        let args: [String: Any] = ["requestId":"type-once", "processId":1, "windowId":1, "action":"type", "text":"synthetic"]
        refusal("mac_tools_paused") { try tools.call("mac_input", arguments: args, grantRevision: 0) }
        let revision = tools.setEnabled(true)
        expectEqual(try tools.call("mac_input", arguments: args, grantRevision: revision)["state"] as? String, "input_dispatched")
        expectEqual(try tools.call("mac_input", arguments: args, grantRevision: revision)["duplicate"] as? Bool, true)
        let restart = try LocalTools(directory: tools.directory, fixtureRoot: root, input: input)
        expectEqual(try restart.call("mac_input", arguments: args, grantRevision: restart.setEnabled(true))["duplicate"] as? Bool, true)
        expectEqual(input.writes, 1)
        input.beforeDispatch = { tools.setEnabled(false) }
        refusal("mac_tools_paused") { try tools.call("mac_input", arguments: args.merging(["requestId":"pause-before-input"]) { _,new in new }, grantRevision: revision) }
        expectEqual(input.writes, 1)
        print("PASS input exact retry/restart and revocation before dispatch")
    }
    func testNativeGrantAndExactFileRetries() throws {
        let (root,tools) = try fixture(); let file = root.appendingPathComponent("result.txt")
        let args: [String:Any] = ["requestId":"write-one","path":file.path,"text":"hello","expectedAbsent":true]
        refusal("mac_tools_paused") { try tools.call("mac_files_write",arguments:args,grantRevision:0) }
        let revision = tools.setEnabled(true)
        refusal("mac_grant_changed") { try tools.call("mac_files_write",arguments:args,grantRevision:0) }
        let first = try tools.call("mac_files_write",arguments:args,grantRevision:revision)
        expectEqual(first["saved"] as? Bool,true)
        let retry = try tools.call("mac_files_write",arguments:args,grantRevision:revision)
        expectEqual(retry["duplicate"] as? Bool,true)
        refusal("request_id_reused") { try tools.call("mac_files_write",arguments:args.merging(["text":"different"]){_,new in new},grantRevision:revision) }
        let current = try tools.call("mac_files_read",arguments:["path":file.path],grantRevision:revision)
        expectEqual(current["text"] as? String,"hello")
        refusal("file_version_changed") { try tools.call("mac_files_write",arguments:["requestId":"stale","path":file.path,"text":"overwrite","expectedSHA256":"wrong"],grantRevision:revision) }
        expectEqual(try String(contentsOf:file,encoding:.utf8),"hello")
        _ = try tools.call("mac_files_write",arguments:["requestId":"next","path":file.path,"text":"new","expectedSHA256":current["sha256"]!],grantRevision:revision)
        // Fresh broker / lost client acknowledgement: the journal returns the saved operation.
        let recovered = try LocalTools(directory:root.appendingPathComponent("broker"),fixtureRoot:root)
        let recoveredRevision = recovered.setEnabled(true)
        expectEqual(try recovered.call("mac_files_write",arguments:args,grantRevision:recoveredRevision)["duplicate"] as? Bool,true)
        expectEqual(try String(contentsOf:file,encoding:.utf8),"new")
    }
    func testActualProcessExitAndNoSecondExecution() throws {
        let (root,tools) = try fixture(); let revision = tools.setEnabled(true)
        let marker = root.appendingPathComponent("count")
        let args: [String:Any] = ["requestId":"run-one","executable":"/bin/sh","arguments":["-c","printf x >> count; printf 'observed output'; exit 7"],"cwd":root.path,"timeoutMs":2000]
        let result = try tools.call("mac_process_run",arguments:args,grantRevision:revision)
        expectEqual(result["exitCode"] as? Int,7); expectEqual(result["output"] as? String,"observed output")
        expectEqual(try tools.call("mac_process_run",arguments:args,grantRevision:revision)["duplicate"] as? Bool,true)
        expectEqual(try String(contentsOf:marker,encoding:.utf8),"x")
        // Neither restart nor a missing result can silently execute again.
        let restarted = try LocalTools(directory:root.appendingPathComponent("broker"),fixtureRoot:root)
        expectEqual(try restarted.call("mac_process_run",arguments:args,grantRevision:restarted.setEnabled(true))["duplicate"] as? Bool,true)
        let record = try FileManager.default.contentsOfDirectory(at:root.appendingPathComponent("broker"),includingPropertiesForKeys:nil).first { $0.lastPathComponent.hasPrefix("operation-") }!
        let old = try JSONSerialization.jsonObject(with:Data(contentsOf:record)) as! [String:Any]
        try JSONSerialization.data(withJSONObject:["basis":old["basis"]!,"state":"prepared"]).write(to:record)
        refusal("operation_unconfirmed_reconcile_before_repeating") { try restarted.call("mac_process_run",arguments:args,grantRevision:1) }
        expectEqual(try String(contentsOf:marker,encoding:.utf8),"x")
    }
    func testTimeoutPauseAndCancellationStopObservedProcesses() throws {
        let (root,tools) = try fixture(); let revision = tools.setEnabled(true)
        let args: [String:Any] = ["requestId":"timeout","executable":"/bin/sleep","arguments":["10"],"cwd":root.path,"timeoutMs":100]
        let result = try tools.call("mac_process_run",arguments:args,grantRevision:revision)
        expectEqual(result["state"] as? String,"timed_out")
        let stopped = expectation(description:"observed paused process")
        DispatchQueue.global().async {
            defer { stopped.fulfill() }
            do {
                let value = try tools.call("mac_process_run",arguments:args.merging(["requestId":"pause","timeoutMs":3000]){_,new in new},grantRevision:revision)
                expectEqual(value["state"] as? String,"paused")
            } catch { failCheck("\(error)") }
        }
        let until = Date().addingTimeInterval(1)
        while tools.status()["runningProcesses"] as? Int == 0 && Date() < until { Thread.sleep(forTimeInterval:0.01) }
        tools.setEnabled(false); wait(for:[stopped],timeout:2)
        expectEqual(tools.status()["runningProcesses"] as? Int,0)
        refusal("mac_tools_paused") { try tools.call("mac_files_read",arguments:["path":root.appendingPathComponent("never").path],grantRevision:revision) }
    }
    func testExplicitCancellationAndOutputCap() throws {
        let (root,tools) = try fixture(); let revision = tools.setEnabled(true)
        let completed = expectation(description:"explicit cancellation observed")
        DispatchQueue.global().async {
            defer { completed.fulfill() }
            do {
                let value = try tools.call("mac_process_run",arguments:["requestId":"cancel-run","executable":"/bin/sleep","arguments":["10"],"cwd":root.path,"timeoutMs":3000],grantRevision:revision)
                expectEqual(value["state"] as? String,"cancelled")
            } catch { failCheck("\(error)") }
        }
        let until = Date().addingTimeInterval(1)
        while tools.status()["runningProcesses"] as? Int == 0 && Date() < until { Thread.sleep(forTimeInterval:0.01) }
        let requested = try tools.call("mac_process_cancel",arguments:["requestId":"cancel-request","targetRequestId":"cancel-run"],grantRevision:revision)
        expectEqual(requested["stopRequested"] as? Bool,true)
        wait(for:[completed],timeout:2)
        let output = try tools.call("mac_process_run",arguments:["requestId":"output-cap","executable":"/usr/bin/yes","arguments":[],"cwd":root.path,"timeoutMs":2000],grantRevision:revision)
        expectEqual(output["state"] as? String,"output_limit")
        expectEqual(output["outputTruncated"] as? Bool,true)
        expectEqual((output["output"] as! String).utf8.count,65536)
    }
    func testMCPTransport() throws {
        let (root, _) = try fixture()
        let tools = try LocalTools(directory: root.appendingPathComponent("mcp-observations"), fixtureRoot: root, observations: FixtureObservation())
        let connection = try LocalToolConnection(service:tools)
        defer { connection.stop() }
        tools.setEnabled(true); try connection.publish()
        let helper = URL(fileURLWithPath:CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("ProjectRoomTools")
        let child = Process(); child.executableURL = helper; child.arguments = ["--connection",connection.connectionURL.path]
        let input = Pipe(), output = Pipe(); child.standardInput = input; child.standardOutput = output; child.standardError = FileHandle.standardError
        try child.run()
        let requests: [[String:Any]] = [
            ["jsonrpc":"2.0","id":1,"method":"initialize","params":["protocolVersion":"2025-06-18"]],
            ["jsonrpc":"2.0","id":2,"method":"tools/list"],
            ["jsonrpc":"2.0","id":3,"method":"tools/call","params":["name":"mac_status","arguments":[:]]],
            ["jsonrpc":"2.0","id":4,"method":"tools/call","params":["name":"mac_process_run","arguments":["requestId":"mcp-process","executable":"/usr/bin/printf","arguments":["%s","literal $(anything)"],"cwd":root.path,"timeoutMs":2000]]],
            ["jsonrpc":"2.0","id":5,"method":"tools/call","params":["name":"mac_app_state","arguments":["processId":1]]],
            ["jsonrpc":"2.0","id":6,"method":"tools/call","params":["name":"mac_screenshot","arguments":["windowId":42]]]
        ]
        for request in requests { var data = try JSONSerialization.data(withJSONObject:request); data.append(10); try input.fileHandleForWriting.write(contentsOf:data) }
        try input.fileHandleForWriting.close()
        let data = try output.fileHandleForReading.readToEnd() ?? Data(); child.waitUntilExit()
        expectEqual(child.terminationStatus,0)
        let replies = try data.split(separator:10).map { try JSONSerialization.jsonObject(with:Data($0)) as! [String:Any] }
        expectEqual(replies.count,6)
        let listed = replies.first { $0["id"] as? Int == 2 }!["result"] as! [String:Any]
        expectEqual((listed["tools"] as! [[String:Any]]).count,8)
        let executed = replies.first { $0["id"] as? Int == 4 }!["result"] as! [String:Any]
        expectEqual(executed["isError"] as? Bool,false)
        expectEqual((executed["structuredContent"] as! [String:Any])["output"] as? String,"literal $(anything)")
        for id in [5, 6] { expectEqual((replies.first { $0["id"] as? Int == id }!["result"] as! [String:Any])["isError"] as? Bool, false) }
        let capture = (replies.first { $0["id"] as? Int == 6 }!["result"] as! [String:Any])["structuredContent"] as! [String:Any]
        expectEqual(capture["uploaded"] as? Bool, false); expectEqual(capture["windowId"] as? Int, 42)
        let screenshotReply = replies.first { $0["id"] as? Int == 6 }!["result"] as! [String: Any]
        let image = (screenshotReply["content"] as! [[String: Any]]).first { $0["type"] as? String == "image" }
        expectEqual(image?["mimeType"] as? String, "image/jpeg")
        expectEqual(Data(base64Encoded: image?["data"] as? String ?? "")!.count <= 600000, true)
    }
    func testPrivateNativeConnectionAndRevocation() throws {
        let (root,tools) = try fixture(); let connection = try LocalToolConnection(service:tools)
        defer { connection.stop() }
        let second = try LocalTools(directory:root.appendingPathComponent("broker"),fixtureRoot:root)
        refusal("mac_tools_already_running") { try LocalToolConnection(service:second) }
        refusal("invalid_tool_arguments") { try LocalToolConnection.call(connectionURL:connection.connectionURL,name:"mac_status",arguments:["grant":true]) }
        let file = root.appendingPathComponent("private.txt")
        refusal("mac_tools_paused") { try LocalToolConnection.call(connectionURL:connection.connectionURL,name:"mac_files_read",arguments:["path":file.path]) }
        tools.setEnabled(true); try connection.publish()
        _ = try LocalToolConnection.call(connectionURL:connection.connectionURL,name:"mac_files_write",arguments:["requestId":"socket-write","path":file.path,"text":"private fixture","expectedAbsent":true])
        expectEqual(try String(contentsOf:file,encoding:.utf8),"private fixture")
        let attrs = try FileManager.default.attributesOfItem(atPath:connection.connectionURL.path)
        expectEqual((attrs[.posixPermissions] as? NSNumber)?.intValue,0o600)
        let forged = root.appendingPathComponent("forged.json")
        var info = try JSONSerialization.jsonObject(with:Data(contentsOf:connection.connectionURL)) as! [String:Any]
        info["token"] = "forged"; try JSONSerialization.data(withJSONObject:info).write(to:forged)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:forged.path)
        refusal("mac_connection_denied") { try LocalToolConnection.call(connectionURL:forged,name:"mac_status",arguments:[:]) }
        tools.setEnabled(false); try connection.publish()
        refusal("mac_tools_paused") { try LocalToolConnection.call(connectionURL:connection.connectionURL,name:"mac_files_read",arguments:["path":file.path]) }
        expectFalse(try LocalToolConnection.call(connectionURL:connection.connectionURL,name:"mac_status",arguments:[:])["remoteDeviceConnection"] as! Bool)
    }
}

let checks = LocalToolsTests()
defer { for action in checks.teardown { action() } }
do {
    try checks.testCapabilityReadiness(); print("PASS capability preflight combinations, native IPC and pause/re-enable projection")
    try checks.testConnectedReadiness(); print("PASS configured tool exposure, provider/room status, stale evidence and targeted corrective actions")
    try MainActor.assumeIsolated { try checks.testReadinessWindow() }; print("PASS My Mac shared readiness copy, enable/pause and dark/light layout")
    try checks.testActualOwnedWindowInput()
    try checks.testInputRetryAndPause()
    try checks.testActualOwnedWindowObservation()
    try checks.testComputerObservations(); print("PASS computer observations, secure redaction, private artifact, grant revocation and explicit permission-gate skips")
    try checks.testNativeGrantAndExactFileRetries(); print("PASS native grant, file versions, exact retries and restart")
    try checks.testActualProcessExitAndNoSecondExecution(); print("PASS real process observation and durable no-repeat")
    try checks.testTimeoutPauseAndCancellationStopObservedProcesses(); print("PASS timeout, pause and observed stop")
    try checks.testExplicitCancellationAndOutputCap(); print("PASS explicit cancellation and bounded returned output")
    try checks.testMCPTransport(); print("PASS actual stdio MCP → native broker → real process")
    try checks.testPrivateNativeConnectionAndRevocation(); print("PASS authenticated native IPC and revocation")
} catch { failCheck("\(error)") }
