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
    try? fm.removeItem(atPath: journal + ".stop")
    let mode = String(data: try Data(contentsOf: URL(fileURLWithPath: args[4])), encoding: .utf8)!
    let directory = journal + ".watch"
    let pinned = ProcessInfo.processInfo.environment["ROOM_HOST_SCOPE"] ?? "missing"
    try pinned.write(toFile: journal + ".scope", atomically: true, encoding: .utf8)
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
let discoveryHome = root.appendingPathComponent("discovery-home")
let discoveryBin = discoveryHome.appendingPathComponent(".local/bin")
try fm.createDirectory(at: discoveryBin, withIntermediateDirectories: true)
let discoveredNode = discoveryBin.appendingPathComponent("node")
try fm.createSymbolicLink(at: discoveredNode, withDestinationURL: URL(fileURLWithPath: executable))
check(LocalRoomHostSetup.installedExecutable("node", home: discoveryHome, searchPath: "") == discoveredNode.path, "Finder launch discovers user-local executable symlink without PATH")
check(LocalRoomHostSetup.installedExecutable("../node", home: discoveryHome, searchPath: "") == nil, "discovery accepts only supported tool names")

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
// Guided setup uses only disposable private folders and executables.
let guided = root.appendingPathComponent("guided")
let connectionFolder = guided.appendingPathComponent("connection")
let workspace = guided.appendingPathComponent("workspace")
let profile = guided.appendingPathComponent("profile")
for folder in [connectionFolder, workspace, profile] {
    try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
}
let connectionFile = connectionFolder.appendingPathComponent("connection.json")
try write(["version": 1, "origin": "https://fixture.invalid", "roomId": "fixture", "memberId": "agent", "token": "fixture-only"], connectionFile.path)
let beforeConnection = try Data(contentsOf: connectionFile)
func selection(_ profileURL: URL, writes: Bool = false) -> LocalRoomHostSetup.Selection {
    .init(node: URL(fileURLWithPath: executable), script: connectionFile, codex: URL(fileURLWithPath: executable), workspace: workspace, profile: profileURL, connection: connectionFolder, allowWrites: writes)
}
let setups = guided.appendingPathComponent("setups")
let generated = try LocalRoomHostSetup.save(selection(profile), directory: setups)
let generatedManifest = try RoomHostManifest.read(generated)
let generatedRuntime = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: generatedManifest.runtimeConfig))) as! [String: Any]
check((generatedRuntime["policy"] as? [String: String])?["sandbox"] == "read-only", "guided setup defaults to read-only")
check(generatedRuntime["macTools"] == nil, "guided setup does not grant computer control")
let afterConnection = try Data(contentsOf: connectionFile)
check(beforeConnection == afterConnection, "guided setup preserves room credentials")
check(generatedRuntime["codexHome"] as? String == profile.path, "guided setup uses chosen dedicated profile")
let guidedHost = try LocalRoomHost(directory: guided.appendingPathComponent("host"))
try guidedHost.configure(generated)
let guidedRestored = try LocalRoomHost(directory: guided.appendingPathComponent("host"))
check(guidedRestored.snapshot()["roomId"] as? String == "fixture" && guidedRestored.snapshot()["running"] as? Bool == false, "guided setup restores selected room without starting")
for path in [generated.path, generatedManifest.runtimeConfig] {
    let attributes = try fm.attributesOfItem(atPath: path)
    check((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "guided configuration is private")
}
let writeManifest = try RoomHostManifest.read(LocalRoomHostSetup.save(selection(profile, writes: true), directory: setups))
let writeRuntime = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: writeManifest.runtimeConfig))) as! [String: Any]
check((writeRuntime["policy"] as? [String: String])?["sandbox"] == "workspace-write", "workspace writing requires explicit selection")
let savedBeforeFailure = try Data(contentsOf: guided.appendingPathComponent("host/selected-host.json"))
for invalid in [workspace, workspace.appendingPathComponent("profile"), fm.homeDirectoryForCurrentUser.appendingPathComponent(".codex/nested")] {
    do { _ = try LocalRoomHostSetup.save(selection(invalid), directory: setups); check(false, "unsafe profile rejected") }
    catch { check((error as? LocalToolFailure)?.code == "setup_dedicated_profile_required", "workspace and ordinary profile descendants refused") }
}
try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: profile.path)
do { _ = try LocalRoomHostSetup.save(selection(profile), directory: setups); check(false, "public profile rejected") }
catch { check((error as? LocalToolFailure)?.code == "setup_private_folder_required", "nonprivate profile refused") }
let savedAfterFailure = try Data(contentsOf: guided.appendingPathComponent("host/selected-host.json"))
check(savedBeforeFailure == savedAfterFailure, "failed setup leaves working configuration intact")
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
check((setupHost.snapshot()["macTools"] as? [String: String])?["mode"] == "approval_required", "observation selection reports input approval requirement")
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
check((setupHost.snapshot()["macTools"] as? [String: String])?["mode"] == "control", "control selection reports configured input exposure")
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
let (changedHost, changedDir) = try fixture("changed")
let changedConnection = changedDir.appendingPathComponent("connection/connection.json")
try write(["origin":"https://fixture.invalid", "roomId":"another-room", "memberId":"agent", "token":"fixture-only"], changedConnection.path)
var refusedChangedRoom = false
do { try changedHost.start() } catch { refusedChangedRoom = (error as? LocalToolFailure)?.code == "room_connection_changed" }
_ = changedHost.stopAndWait()
check(refusedChangedRoom, "changed room connection refused before starting host")
let (host,dir) = try fixture("normal")
let saved = dir.appendingPathComponent("managed/selected-host.json")
let savedAttributes = try fm.attributesOfItem(atPath:saved.path)
check((savedAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "saved manifest private")
let restored = try LocalRoomHost(directory:dir.appendingPathComponent("managed"))
check(restored.snapshot()["configured"] as? Bool == true && restored.snapshot()["running"] as? Bool == false, "restores setup without automatic execution")
try write(["origin":"https://fixture.invalid", "roomId":"fixture", "memberId":"agent", "token":"rotated-fixture-token"], dir.appendingPathComponent("connection/connection.json").path)
try host.start()
check(host.snapshot()["running"] as? Bool == true, "same-identity token rotation remains startable")
do { try host.connectMacTools(executable: URL(fileURLWithPath: executable), connection: nativeConnection, allowInput: true); check(false, "active configuration refused") }
catch { print("PASS: active host configuration cannot change") }
check(until { (host.snapshot()["message"] as? String)?.hasPrefix("Listening") == true }, "owned fresh status reaches listening without claiming model ready")
check(host.snapshot()["statusFresh"] as? Bool == true && host.snapshot()["credentials"] as? String == "not_required", "fresh native snapshot exposes qualified provider evidence")
do { try restored.start(); check(false,"duplicate refused") } catch { print("PASS: duplicate desktop host refused") }
let pinnedScope = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: host.journalURL!.path + ".scope"))) as! [String: String]
check(pinnedScope == ["origin":"https://fixture.invalid", "roomId":"fixture", "memberId":"agent"], "child receives exact selected room identity without a token")
check(host.stopAndWait(), "graceful stop waits for child")
check(host.snapshot()["message"] as? String == "Agent stopped", "terminal status and exit both confirm stop")
// App shutdown preserves intent; explicit disconnect survives a new app instance.
let resumed = try LocalRoomHost(directory: dir.appendingPathComponent("managed"))
check(resumed.snapshot()["receivingEnabled"] as? Bool == true, "shutdown preserves receiving preference")
try resumed.resumeReceiving()
check(until { resumed.snapshot()["statusFresh"] as? Bool == true }, "saved receiver starts without opening controls")
try resumed.disconnect()
check(resumed.stopAndWait(), "explicit disconnect stops receiver")
let disconnected = try LocalRoomHost(directory: dir.appendingPathComponent("managed"))
try disconnected.resumeReceiving()
check(disconnected.snapshot()["running"] as? Bool == false && disconnected.snapshot()["receivingEnabled"] as? Bool == false, "disconnect persists across relaunch")
let preference = dir.appendingPathComponent("managed/receiving.json")
let preferenceAttributes = try fm.attributesOfItem(atPath: preference.path)
check((preferenceAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600, "receiving preference private")
try write(["enabled": true, "scope": ["origin": "https://fixture.invalid", "roomId": "other-room", "memberId": "agent"]], preference.path)
let wrongScope = try LocalRoomHost(directory: dir.appendingPathComponent("managed"))
try wrongScope.resumeReceiving()
check(wrongScope.snapshot()["running"] as? Bool == false, "another room cannot inherit receiving intent")
try disconnected.start()
check(disconnected.stopAndWait(), "restart can reenable receiving")
try disconnected.configure(saved)
let reconfigured = try LocalRoomHost(directory: dir.appendingPathComponent("managed"))
try reconfigured.resumeReceiving()
check(reconfigured.snapshot()["running"] as? Bool == false, "reconfiguration requires explicit start")
try Data("invalid".utf8).write(to: preference)
let corrupt = try LocalRoomHost(directory: dir.appendingPathComponent("managed"))
try corrupt.resumeReceiving()
check(corrupt.snapshot()["running"] as? Bool == false, "corrupt preference never starts receiver")
// A failed preference write must never retain live receiving intent.
let (failedDisconnect, failedDir) = try fixture("failed-disconnect")
try failedDisconnect.start()
check(failedDisconnect.stopAndWait(), "failed-write fixture shuts down without clearing receiving")
let failedPreference = failedDir.appendingPathComponent("managed/receiving.json")
try fm.removeItem(at: failedPreference)
try fm.createDirectory(at: failedPreference, withIntermediateDirectories: false)
try Data("fixture".utf8).write(to: failedPreference.appendingPathComponent("blocker"))
var disconnectFailed = false
do { try failedDisconnect.disconnect() } catch { disconnectFailed = true }
check(disconnectFailed, "disconnect surfaces preference persistence failure")
check(failedDisconnect.snapshot()["receivingEnabled"] as? Bool == false, "failed disconnect immediately clears in-memory intent")
try failedDisconnect.resumeReceiving()
check(failedDisconnect.snapshot()["receivingEnabled"] as? Bool == false && failedDisconnect.snapshot()["running"] as? Bool == false, "failed disconnect persistence cannot reenable receiving in this process")
// A binary can disappear or become invalid after configuration succeeds.
let (failedStart, startDir) = try fixture("failed-start")
let invalidNode = startDir.appendingPathComponent("invalid-node")
try Data("not an executable format".utf8).write(to: invalidNode)
try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: invalidNode.path)
let invalidManifest = startDir.appendingPathComponent("host.json")
try write(["version":1,"node":invalidNode.path,"script":startDir.appendingPathComponent("runtime.json").path,"runtimeConfig":startDir.appendingPathComponent("runtime.json").path,"roomConnection":startDir.appendingPathComponent("connection").path], invalidManifest.path)
try failedStart.configure(invalidManifest)
var startFailed = false
do { try failedStart.start() } catch { startFailed = true }
check(startFailed, "first start reports executable spawn failure")
check(failedStart.snapshot()["receivingEnabled"] as? Bool == false, "failed first start does not arm future automatic receiving")
let failedStartRestored = try LocalRoomHost(directory: startDir.appendingPathComponent("managed"))
try failedStartRestored.resumeReceiving()
check(failedStartRestored.snapshot()["receivingEnabled"] as? Bool == false, "failed first start remains disabled after relaunch")
for mode in ["wrongpid","stale","unverified","exit"] {
    let (other,_) = try fixture(mode); try other.start(); Thread.sleep(forTimeInterval:0.4)
    check(!(other.snapshot()["message"] as? String ?? "").hasPrefix("Listening"), "\(mode) status cannot claim listening")
    if mode == "wrongpid" || mode == "stale" {
        check(other.snapshot()["statusFresh"] as? Bool == false && other.snapshot()["credentials"] as? String == "unknown", "\(mode) cannot carry fresh provider evidence")
    }
    check(other.stopAndWait(), "\(mode) cleanup bounded")
}
let (resistant,_) = try fixture("resistant"); try resistant.start()
let childPath = resistant.journalURL!.path + ".child"
check(until { fm.fileExists(atPath:childPath) }, "resistant descendant started")
let child = Int32(try String(contentsOfFile:childPath))!
check(resistant.stopAndWait(), "resistant process group shutdown bounded")
check(until { kill(child,0) != 0 }, "resistant descendant removed")
check(resistant.snapshot()["message"] as? String == "Host ended · execution needs reconciliation", "forced termination does not assert model stopped")
check(resistant.snapshot()["lastExit"] as? String == "unconfirmed", "forced exit remains an actionable unresolved status")
print("LOCAL_ROOM_HOST_ACCEPTANCE_OK")
