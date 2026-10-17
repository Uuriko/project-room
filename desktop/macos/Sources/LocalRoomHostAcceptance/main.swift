import Foundation
import Darwin
import ProjectRoomKit

let fm = FileManager.default
func write(_ object: [String: Any], _ path: String) throws {
    try JSONSerialization.data(withJSONObject: object).write(to: URL(fileURLWithPath: path), options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
}
func stamp() -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime,.withFractionalSeconds]; return f.string(from: Date()) }
// The acceptance executable itself is the fake node binary. No account, model,
// live room, macOS permission, or installed app is touched.
if CommandLine.arguments.count > 3, CommandLine.arguments[2].hasPrefix("--") {
    let args = CommandLine.arguments, journal = args[3]
    if args[2] == "--stop-watch" { fm.createFile(atPath: journal + ".stop", contents: Data()); exit(0) }
    let mode = String(data: try Data(contentsOf: URL(fileURLWithPath: args[4])), encoding: .utf8)!
    let directory = journal + ".watch"
    try fm.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let started = stamp(), session = UUID().uuidString.lowercased()
    func status(_ phase: String) throws {
        try write(["schemaVersion":1,"pid": mode == "wrongpid" ? Int(getpid()) + 1 : Int(getpid()), "sessionId":session,
            "startedAt":started,"updatedAt":mode == "stale" ? "2000-01-01T00:00:00.000Z" : stamp(),
            "origin":"https://fixture.invalid", "roomId":"fixture", "memberId":"agent", "phase":phase,
            "protocol": mode == "unverified" ? "unverified" : "qualified", "credentials":"not_required", "modelExecution":"not_tested"], directory + "/status.json")
    }
    if mode == "resistant" {
        signal(SIGTERM, SIG_IGN)
        var child: pid_t = 0
        let command: [String] = ["/bin/sh", "-c", "trap '' TERM; while :; do /bin/sleep 1; done"]
        let argv = command.map { strdup($0) } + [nil]
        var empty: UnsafeMutablePointer<CChar>? = nil
        defer { for p in argv { if let p { free(p) } } }
        let code = argv.withUnsafeBufferPointer { posix_spawn(&child, "/bin/sh", nil, nil, UnsafeMutablePointer(mutating:$0.baseAddress!), &empty) }
        guard code == 0 else { exit(5) }
        try String(child).write(toFile: journal + ".child", atomically: true, encoding: .utf8)
    }
    try status("watching_room")
    if mode == "exit" { exit(3) }
    while true {
        if mode != "resistant" && fm.fileExists(atPath: journal + ".stop") { try status("stopped"); exit(0) }
        Thread.sleep(forTimeInterval: 0.1)
    }
}
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    guard condition() else { fputs("FAIL: \(label)\n", stderr); exit(1) }
    print("PASS: \(label)")
}
func until(_ predicate: () -> Bool, seconds: Double = 4) -> Bool {
    let end = Date().addingTimeInterval(seconds)
    repeat { if predicate() { return true }; Thread.sleep(forTimeInterval: 0.05) } while Date() < end
    return predicate()
}
let root = fm.temporaryDirectory.appendingPathComponent("room-native-host-\(UUID())")
try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions:0o700])
defer { try? fm.removeItem(at: root) }
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
func fixture(_ name: String) throws -> (LocalRoomHost, URL) {
    let dir = root.appendingPathComponent(name), connection = dir.appendingPathComponent("connection")
    try fm.createDirectory(at: connection, withIntermediateDirectories:true, attributes:[.posixPermissions:0o700])
    try write(["origin":"https://fixture.invalid","roomId":"fixture","memberId":"agent","token":"fixture-only"], connection.appendingPathComponent("connection.json").path)
    let runtime = dir.appendingPathComponent("runtime.json"); try name.write(to:runtime, atomically:true, encoding:.utf8)
    let manifest = dir.appendingPathComponent("host.json")
    try write(["version":1,"node":executable,"script":runtime.path,"runtimeConfig":runtime.path,"roomConnection":connection.path], manifest.path)
    let host = try LocalRoomHost(directory:dir.appendingPathComponent("managed")); try host.configure(manifest)
    return (host,dir)
}
let (setupHost, setupDir) = try fixture("setup")
let sourceRuntime = setupDir.appendingPathComponent("runtime.json")
let runtimeSettings: [String: Any] = ["command": executable, "cwd": setupDir.path,
    "codexHome": root.appendingPathComponent("dedicated-profile").path,
    "policy": ["approvalPolicy": "never", "sandbox": "workspace-write"]]
try write(runtimeSettings, sourceRuntime.path)
let originalRuntime = try Data(contentsOf: sourceRuntime)
let nativeConnection = setupDir.appendingPathComponent("native-connection.json")
try write(["fixture": true], nativeConnection.path)
try setupHost.connectMacTools(executable: URL(fileURLWithPath: executable), connection: nativeConnection, allowInput: false)
let setupSaved = setupDir.appendingPathComponent("managed/selected-host.json")
let observedManifest = try RoomHostManifest.read(setupSaved)
let observedRuntime = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: observedManifest.runtimeConfig))) as! [String: Any]
check((observedRuntime["macTools"] as? [String: Any])?["inputApproval"] as? String == "prompt", "observation setup does not approve input")
check(observedRuntime["codexHome"] as? String == runtimeSettings["codexHome"] as? String, "dedicated provider profile preserved")
let unchangedRuntime = try Data(contentsOf: sourceRuntime)
check(unchangedRuntime == originalRuntime, "imported runtime remains unchanged")
let managedAttributes = try fm.attributesOfItem(atPath: observedManifest.runtimeConfig)
check((managedAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "generated runtime private")
try setupHost.connectMacTools(executable: URL(fileURLWithPath: executable), connection: nativeConnection, allowInput: true)
let approvedManifest = try RoomHostManifest.read(setupSaved)
let approvedRuntime = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: approvedManifest.runtimeConfig))) as! [String: Any]
check((approvedRuntime["macTools"] as? [String: Any])?["inputApproval"] as? String == "approve", "explicit owner choice connects input")
check(!fm.fileExists(atPath: observedManifest.runtimeConfig), "replaced generated runtime removed")
let setupRestored = try LocalRoomHost(directory: setupDir.appendingPathComponent("managed"))
check(setupRestored.snapshot()["roomId"] as? String == "fixture" && setupRestored.snapshot()["running"] as? Bool == false, "restored setup shows room without starting execution")
try fm.setAttributes([.posixPermissions: 0o644], ofItemAtPath: nativeConnection.path)
do { try setupHost.connectMacTools(executable: URL(fileURLWithPath: executable), connection: nativeConnection, allowInput: true); check(false, "public connection refused") }
catch { print("PASS: nonprivate native connection refused") }
let retainedManifest = try RoomHostManifest.read(setupSaved)
check(retainedManifest.runtimeConfig == approvedManifest.runtimeConfig, "failed setup preserves working configuration")
let (host,dir) = try fixture("normal")
let saved = dir.appendingPathComponent("managed/selected-host.json")
let savedAttributes = try fm.attributesOfItem(atPath:saved.path)
check((savedAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "saved manifest private")
let restored = try LocalRoomHost(directory:dir.appendingPathComponent("managed"))
check(restored.snapshot()["configured"] as? Bool == true && restored.snapshot()["running"] as? Bool == false, "restores setup without automatic execution")
try host.start()
do { try host.connectMacTools(executable: URL(fileURLWithPath: executable), connection: nativeConnection, allowInput: true); check(false, "active configuration refused") }
catch { print("PASS: active host configuration cannot change") }
check(until { (host.snapshot()["message"] as? String)?.hasPrefix("Listening") == true }, "owned fresh status reaches listening without claiming model ready")
do { try restored.start(); check(false,"duplicate refused") } catch { print("PASS: duplicate desktop host refused") }
check(host.stopAndWait(), "graceful stop waits for child")
check(host.snapshot()["message"] as? String == "Agent stopped", "terminal status and exit both confirm stop")
for mode in ["wrongpid","stale","unverified","exit"] {
    let (other,_) = try fixture(mode); try other.start(); Thread.sleep(forTimeInterval:0.4)
    check(!(other.snapshot()["message"] as? String ?? "").hasPrefix("Listening"), "\(mode) status cannot claim listening")
    check(other.stopAndWait(), "\(mode) cleanup bounded")
}
let (resistant,_) = try fixture("resistant"); try resistant.start()
let childPath = resistant.journalURL!.path + ".child"
check(until { fm.fileExists(atPath:childPath) }, "resistant descendant started")
let child = Int32(try String(contentsOfFile:childPath))!
check(resistant.stopAndWait(), "resistant process group shutdown bounded")
check(until { kill(child,0) != 0 }, "resistant descendant removed")
check(resistant.snapshot()["message"] as? String == "Host ended · execution needs reconciliation", "forced termination does not assert model stopped")
print("LOCAL_ROOM_HOST_ACCEPTANCE_OK")
