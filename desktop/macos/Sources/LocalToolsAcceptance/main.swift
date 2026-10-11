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
        let count = try FileManager.default.contentsOfDirectory(atPath: tools.directory.path).filter { $0.hasPrefix("capture-") }.count
        provider.beforeReturn = { tools.setEnabled(false) }
        refusal("mac_tools_paused") { try tools.call("mac_screenshot", arguments: ["windowId": 42], grantRevision: revision) }
        expectEqual(try FileManager.default.contentsOfDirectory(atPath: tools.directory.path).filter { $0.hasPrefix("capture-") }.count, count)
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
        expectEqual((listed["tools"] as! [[String:Any]]).count,7)
        let executed = replies.first { $0["id"] as? Int == 4 }!["result"] as! [String:Any]
        expectEqual(executed["isError"] as? Bool,false)
        expectEqual((executed["structuredContent"] as! [String:Any])["output"] as? String,"literal $(anything)")
        for id in [5, 6] { expectEqual((replies.first { $0["id"] as? Int == id }!["result"] as! [String:Any])["isError"] as? Bool, false) }
        let capture = (replies.first { $0["id"] as? Int == 6 }!["result"] as! [String:Any])["structuredContent"] as! [String:Any]
        expectEqual(capture["uploaded"] as? Bool, false); expectEqual(capture["windowId"] as? Int, 42)
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
    try checks.testActualOwnedWindowObservation()
    try checks.testComputerObservations(); print("PASS computer observations, secure redaction, private artifact, grant revocation and explicit permission-gate skips")
    try checks.testNativeGrantAndExactFileRetries(); print("PASS native grant, file versions, exact retries and restart")
    try checks.testActualProcessExitAndNoSecondExecution(); print("PASS real process observation and durable no-repeat")
    try checks.testTimeoutPauseAndCancellationStopObservedProcesses(); print("PASS timeout, pause and observed stop")
    try checks.testExplicitCancellationAndOutputCap(); print("PASS explicit cancellation and bounded returned output")
    try checks.testMCPTransport(); print("PASS actual stdio MCP → native broker → real process")
    try checks.testPrivateNativeConnectionAndRevocation(); print("PASS authenticated native IPC and revocation")
} catch { failCheck("\(error)") }
