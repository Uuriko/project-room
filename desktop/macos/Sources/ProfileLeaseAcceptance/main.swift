import Foundation
import Darwin
import ProjectRoomKit

let arguments = CommandLine.arguments
if arguments.count == 4 {
    do {
        let lease = try RoomProfileLease(profileID: UUID(uuidString: arguments[3]), directory: URL(fileURLWithPath: arguments[2]))
        withExtendedLifetime(lease) {
            if arguments[1] == "hold" {
                FileHandle.standardOutput.write(Data([1]))
                while true { pause() }
            }
        }
        exit(0)
    } catch ProfileLeaseError.inUse { exit(10) }
    catch { exit(20) }
}

let directory = FileManager.default.temporaryDirectory.appendingPathComponent("room-profile-lock-test-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: directory) }
let profile = UUID()
func child(_ mode: String, _ id: UUID?, output: Pipe? = nil) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: arguments[0]).standardizedFileURL
    process.arguments = [mode, directory.path, id?.uuidString ?? "default"]
    if let output { process.standardOutput = output }
    try process.run()
    return process
}
func check(_ passed: Bool, _ message: String) {
    guard passed else { fputs("FAIL: \(message)\n", stderr); exit(1) }
    print("PASS: \(message)")
}
func probe(_ id: UUID?) throws -> Int32 {
    let process = try child("probe", id)
    process.waitUntilExit()
    return process.terminationStatus
}
do {
    var lease: RoomProfileLease? = try RoomProfileLease(profileID: profile, directory: directory)
    try withExtendedLifetime(lease) {
        check(try probe(profile) == 10, "another process cannot open the same profile")
        check(try probe(UUID()) == 0, "different profiles can run concurrently")
        check(try probe(nil) == 0, "named profile does not block Default")
    }
    lease = nil
    check(try probe(profile) == 0, "normal release allows reopening")
    let defaultLease = try RoomProfileLease(profileID: nil, directory: directory)
    try withExtendedLifetime(defaultLease) {
        check(try probe(nil) == 10, "Default is also protected")
    }
    let ready = Pipe()
    let crashed = try child("hold", profile, output: ready)
    try ready.fileHandleForWriting.close()
    // A bounded watchdog prevents a broken child from hanging acceptance.
    DispatchQueue.global().asyncAfter(deadline: .now() + 10) {
        if crashed.isRunning { kill(crashed.processIdentifier, SIGKILL) }
    }
    check(ready.fileHandleForReading.readData(ofLength: 1) == Data([1]), "child acquired crash-test lease")
    check(try probe(profile) == 10, "live child owns lease")
    kill(crashed.processIdentifier, SIGKILL)
    crashed.waitUntilExit()
    check(try probe(profile) == 0, "crash releases lease without stale-lock cleanup")
} catch { fputs("FAIL: \(error)\n", stderr); exit(1) }
