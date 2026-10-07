import Foundation
final class Expectation { let semaphore = DispatchSemaphore(value:0); func fulfill() { semaphore.signal() } }
func failCheck(_ message: String) { fputs("FAILED: \(message)\n", stderr); exit(1) }
func expectEqual<T: Equatable>(_ actual: T, _ expected: T) { if actual != expected { failCheck("\(actual) != \(expected)") } }
func expectFalse(_ value: Bool) { if value { failCheck("Expected false") } }
func expectError(_ expression: @autoclosure () throws -> Any, _ handler: (Error) -> Void) { do { _ = try expression(); failCheck("Expected refusal") } catch { handler(error) } }
import ProjectRoomKit

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
        let (root,tools) = try fixture(); let connection = try LocalToolConnection(service:tools)
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
            ["jsonrpc":"2.0","id":4,"method":"tools/call","params":["name":"mac_process_run","arguments":["requestId":"mcp-process","executable":"/usr/bin/printf","arguments":["%s","literal $(anything)"],"cwd":root.path,"timeoutMs":2000]]]
        ]
        for request in requests { var data = try JSONSerialization.data(withJSONObject:request); data.append(10); try input.fileHandleForWriting.write(contentsOf:data) }
        try input.fileHandleForWriting.close()
        let data = try output.fileHandleForReading.readToEnd() ?? Data(); child.waitUntilExit()
        expectEqual(child.terminationStatus,0)
        let replies = try data.split(separator:10).map { try JSONSerialization.jsonObject(with:Data($0)) as! [String:Any] }
        expectEqual(replies.count,4)
        let listed = replies.first { $0["id"] as? Int == 2 }!["result"] as! [String:Any]
        expectEqual((listed["tools"] as! [[String:Any]]).count,5)
        let executed = replies.first { $0["id"] as? Int == 4 }!["result"] as! [String:Any]
        expectEqual(executed["isError"] as? Bool,false)
        expectEqual((executed["structuredContent"] as! [String:Any])["output"] as? String,"literal $(anything)")
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
    try checks.testNativeGrantAndExactFileRetries(); print("PASS native grant, file versions, exact retries and restart")
    try checks.testActualProcessExitAndNoSecondExecution(); print("PASS real process observation and durable no-repeat")
    try checks.testTimeoutPauseAndCancellationStopObservedProcesses(); print("PASS timeout, pause and observed stop")
    try checks.testExplicitCancellationAndOutputCap(); print("PASS explicit cancellation and bounded returned output")
    try checks.testMCPTransport(); print("PASS actual stdio MCP → native broker → real process")
    try checks.testPrivateNativeConnectionAndRevocation(); print("PASS authenticated native IPC and revocation")
} catch { failCheck("\(error)") }
