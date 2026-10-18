import Foundation
import CryptoKit
import Darwin

public struct RoomHostManifest: Codable {
    public let version: Int
    public let node: String
    public let script: String
    public let runtimeConfig: String
    public let roomConnection: String
    public static func read(_ url: URL) throws -> RoomHostManifest {
        let data = try Data(contentsOf: url)
        guard data.count <= 65536 else { throw LocalToolFailure("invalid_host_manifest") }
        let value = try JSONDecoder().decode(RoomHostManifest.self, from: data)
        guard value.version == 1 else { throw LocalToolFailure("invalid_host_manifest") }
        for path in [value.node, value.script, value.runtimeConfig, value.roomConnection] {
            guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count < 4096 else { throw LocalToolFailure("invalid_host_manifest") }
        }
        guard FileManager.default.isExecutableFile(atPath: value.node), FileManager.default.isReadableFile(atPath: value.script),
            FileManager.default.isReadableFile(atPath: value.runtimeConfig),
            FileManager.default.isReadableFile(atPath: URL(fileURLWithPath: value.roomConnection).appendingPathComponent("connection.json").path)
        else { throw LocalToolFailure("host_setup_unavailable") }
        return value
    }
}

// One app-lifetime child; the existing JS WatchJournal owns runtime supervision.
// No login item, launch daemon, credential import, or WebKit execution bridge.
public final class LocalRoomHost {
    private let lock = NSLock()
    private let work = DispatchQueue(label: "project-room.native-host", qos: .utility)
    private let finished = DispatchGroup()
    private let directory: URL
    private var manifest: RoomHostManifest?
    private var pid: pid_t = 0
    private var ownerFD: Int32 = -1
    private var stopping = false
    private var launchTime = Date.distantPast
    private var lastMessage = "Connect an agent to this room"
    private var scope: [String: String] = [:]
    private var session: String?
    private var macTools: [String: String] = ["mode": "unknown"]
    private var lastExit = "none"
    public private(set) var journalURL: URL?
    public init(directory: URL? = nil) throws {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Project Room/Room Host")
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.directory.path)
        let saved = self.directory.appendingPathComponent("selected-host.json")
        if FileManager.default.fileExists(atPath: saved.path) { try? configure(saved) }
    }
    private static func connectionIdentity(_ selected: RoomHostManifest) throws -> [String: String] {
        let connectionURL = URL(fileURLWithPath: selected.roomConnection).appendingPathComponent("connection.json")
        let data = try Data(contentsOf: connectionURL)
        guard data.count <= 4096, let identity = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let origin = identity["origin"] as? String, let roomId = identity["roomId"] as? String, let memberId = identity["memberId"] as? String,
            !origin.isEmpty, !roomId.isEmpty, !memberId.isEmpty else { throw LocalToolFailure("invalid_room_connection") }
        return ["origin": origin, "roomId": roomId, "memberId": memberId]
    }
    public func configure(_ url: URL) throws {
        let selected = try RoomHostManifest.read(url)
        let identity = try Self.connectionIdentity(selected)
        let key = SHA256.hash(data: Data(URL(fileURLWithPath: selected.roomConnection).resolvingSymlinksInPath().path.utf8)).map { String(format: "%02x", $0) }.joined()
        lock.lock(); defer { lock.unlock() }
        guard pid == 0 else { throw LocalToolFailure("host_already_running") }
        let saved = directory.appendingPathComponent("selected-host.json")
        try JSONEncoder().encode(selected).write(to: saved, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: saved.path)
        manifest = selected; scope = identity
        lastExit = "none"
        macTools = LocalHostReadiness.toolConfiguration(URL(fileURLWithPath: selected.runtimeConfig))
        journalURL = directory.appendingPathComponent("room-\(key).sqlite")
        lastMessage = "Ready to start · \(identity["roomId"]!)"
    }
    // Save a private managed copy: selecting Mac tools must never rewrite an
    // imported runtime shared with a terminal host or another application.
    public func connectMacTools(executable: URL, connection: URL, allowInput: Bool) throws {
        lock.lock(); let selected = manifest, active = pid != 0 || stopping; lock.unlock()
        guard !active else { throw LocalToolFailure("host_already_running") }
        guard let selected else { throw LocalToolFailure("host_not_configured") }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else { throw LocalToolFailure("mac_tools_unavailable") }
        let attributes = try FileManager.default.attributesOfItem(atPath: connection.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
            (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
            ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0
        else { throw LocalToolFailure("invalid_mac_connection") }
        let source = URL(fileURLWithPath: selected.runtimeConfig)
        let data = try Data(contentsOf: source)
        guard data.count <= 65536, var runtime = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LocalToolFailure("invalid_runtime_configuration")
        }
        runtime["macTools"] = ["command": executable.path, "connection": connection.path,
            "inputApproval": allowInput ? "approve" : "prompt"]
        let managed = directory.appendingPathComponent("mac-runtime-\(UUID().uuidString).json")
        let temporary = directory.appendingPathComponent("mac-host-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            try JSONSerialization.data(withJSONObject: runtime, options: [.sortedKeys]).write(to: managed, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: managed.path)
            let updated = RoomHostManifest(version: 1, node: selected.node, script: selected.script,
                runtimeConfig: managed.path, roomConnection: selected.roomConnection)
            try JSONEncoder().encode(updated).write(to: temporary, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            try configure(temporary)
        } catch { try? FileManager.default.removeItem(at: managed); throw error }
        // Replacing this app's own generated copy does not accumulate old profiles.
        if source.deletingLastPathComponent().standardizedFileURL.path == directory.standardizedFileURL.path && source.lastPathComponent.hasPrefix("mac-runtime-") {
            try? FileManager.default.removeItem(at: source)
        }
    }
    private func spawn(_ manifest: RoomHostManifest, arguments: [String], selectedScope: [String: String]? = nil) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?, attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        for fd in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] { posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == STDIN_FILENO ? O_RDONLY : O_WRONLY, 0) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)); posix_spawnattr_setpgroup(&attributes, 0)
        var environment = ["PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME=\(NSHomeDirectory())", "LANG=en_US.UTF-8", "TMPDIR=\(NSTemporaryDirectory())", "ROOM_AGENT_CONFIG=\(manifest.roomConnection)"]
        if let selectedScope {
            let encoded = try JSONSerialization.data(withJSONObject: selectedScope, options: [.sortedKeys])
            environment.append("ROOM_HOST_SCOPE=\(String(decoding: encoded, as: UTF8.self))")
        }
        let argv = ([manifest.node, manifest.script] + arguments).map { strdup($0) } + [nil]
        let env = environment.map { strdup($0) } + [nil]
        defer { for pointer in argv + env { if let pointer { free(pointer) } } }
        var child: pid_t = 0
        let code = argv.withUnsafeBufferPointer { a in env.withUnsafeBufferPointer { e in
            posix_spawn(&child, manifest.node, &actions, &attributes, UnsafeMutablePointer(mutating: a.baseAddress!), UnsafeMutablePointer(mutating: e.baseAddress!))
        } }
        guard code == 0 else { throw LocalToolFailure("host_could_not_start") }
        return child
    }
    public func start() throws {
        lock.lock(); defer { lock.unlock() }
        guard pid == 0, !stopping else { throw LocalToolFailure("host_already_running") }
        guard let manifest, let journalURL else { throw LocalToolFailure("host_not_configured") }
        guard (try? Self.connectionIdentity(manifest)) == scope else { throw LocalToolFailure("room_connection_changed") }
        macTools = LocalHostReadiness.toolConfiguration(URL(fileURLWithPath: manifest.runtimeConfig))
        let fd = Darwin.open(directory.appendingPathComponent("desktop-owner.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw LocalToolFailure("host_lock_unavailable") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw LocalToolFailure("another_desktop_host_running") }
        do { pid = try spawn(manifest, arguments: ["--watch", journalURL.path, manifest.runtimeConfig], selectedScope: scope) }
        catch { close(fd); throw error }
        ownerFD = fd; stopping = false; session = nil; launchTime = Date(); lastMessage = "Starting agent…"
        lastExit = "none"
        let child = pid; finished.enter()
        work.async { [self] in supervise(child, manifest: manifest, journal: journalURL); finished.leave() }
    }
    private func exited(_ child: pid_t) -> Bool {
        var info = siginfo_t()
        return waitid(P_PID, id_t(child), &info, WEXITED | WNOHANG | WNOWAIT) == 0 && info.si_pid == child
    }
    private func waitExit(_ child: pid_t, seconds: Double) -> Bool {
        let until = Date().addingTimeInterval(seconds)
        repeat { if exited(child) { return true }; Thread.sleep(forTimeInterval: 0.05) } while Date() < until
        return exited(child)
    }
    private func reapGroup(_ child: pid_t) {
        // The direct child remains unreaped until its owned group is cleaned,
        // so this PID cannot be reused for somebody else's process group.
        kill(-child, SIGKILL)
        _ = waitExit(child, seconds: 1)
        var status: Int32 = 0; _ = waitpid(child, &status, WNOHANG)
    }
    private func supervise(_ child: pid_t, manifest: RoomHostManifest, journal: URL) {
        var requested = false
        while !exited(child) {
            lock.lock(); requested = stopping; lock.unlock()
            if requested { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if requested {
            if let control = try? spawn(manifest, arguments: ["--stop-watch", journal.path]) {
                _ = waitExit(control, seconds: 2); reapGroup(control)
            }
            if !waitExit(child, seconds: 3) { kill(-child, SIGTERM); _ = waitExit(child, seconds: 5) }
        }
        let receipt = readStatus(child: child)
        let confirmed = receipt?["phase"] as? String == "stopped" && exited(child)
        reapGroup(child)
        lock.lock()
        pid = 0; stopping = false
        lastExit = confirmed ? "confirmed_stop" : "unconfirmed"
        lastMessage = confirmed ? "Agent stopped" : requested ? "Host ended · execution needs reconciliation" : "Agent ended · check connection setup"
        if ownerFD >= 0 { close(ownerFD); ownerFD = -1 }
        lock.unlock()
    }
    public func requestStop() { lock.lock(); if pid != 0 { stopping = true; lastMessage = "Stopping agent…" }; lock.unlock() }
    @discardableResult public func stopAndWait(timeout: Double = 14) -> Bool {
        requestStop(); return finished.wait(timeout: .now() + timeout) == .success
    }
    private static func timestamp(_ text: String) -> Date? {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text)
    }
    private func readStatus(child: pid_t) -> [String: Any]? {
        lock.lock(); let journal = journalURL, expected = scope, started = launchTime, priorSession = session; lock.unlock()
        guard let journal else { return nil }
        let url = URL(fileURLWithPath: journal.path + ".watch/status.json")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path), attributes[.type] as? FileAttributeType == .typeRegular,
            ((attributes[.size] as? NSNumber)?.intValue ?? Int.max) <= 16384,
            (((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077) == 0,
            let data = try? Data(contentsOf: url), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            value["schemaVersion"] as? Int == 1, value["pid"] as? Int32 == child,
            let id = value["sessionId"] as? String, UUID(uuidString: id) != nil, priorSession == nil || priorSession == id,
            expected.allSatisfy({ value[$0.key] as? String == $0.value }),
            let updatedText = value["updatedAt"] as? String, let beganText = value["startedAt"] as? String,
            let updated = Self.timestamp(updatedText), let began = Self.timestamp(beganText),
            began >= started.addingTimeInterval(-2), updated <= Date().addingTimeInterval(2),
            Date().timeIntervalSince(updated) <= 15 else { return nil }
        lock.lock(); if pid == child { session = id }; lock.unlock()
        return value
    }
    public func snapshot() -> [String: Any] {
        lock.lock(); let child = pid, message = lastMessage, configured = manifest != nil, isStopping = stopping, selectedScope = scope, selectedTools = macTools, exitState = lastExit; lock.unlock()
        var text = message
        var evidence: [String: Any] = ["statusFresh": false, "phase": "unknown", "protocol": "unverified", "credentials": "unknown"]
        if child != 0 && !isStopping {
            if let value = readStatus(child: child) {
                evidence = ["statusFresh": true, "phase": value["phase"] as? String ?? "unknown",
                            "protocol": value["protocol"] as? String ?? "unverified", "credentials": value["credentials"] as? String ?? "unknown"]
                if value["credentials"] as? String == "login_required" { text = "Sign in to the dedicated Codex account" }
                else {
                    switch value["phase"] as? String {
                    case "running": text = "Working on a shared ask"
                    case "watching_room", "protocol_qualified", "settled":
                        text = value["protocol"] as? String == "qualified" && ["present", "not_required"].contains(value["credentials"] as? String ?? "") ? "Listening · model execution not verified" : "Connecting · checking agent setup"
                    case "recovery_pending": text = "Waiting for execution reconciliation"
                    case "retrying_room": text = "Reconnecting to the room…"
                    case "stopped": text = "Stopping agent…"
                    default: text = "Starting agent…"
                    }
                }
            } else { text = "Connecting · current status unavailable" }
        }
        return evidence.merging(["configured": configured, "running": child != 0, "stopping": isStopping, "message": text,
            "macTools": selectedTools, "lastExit": exitState, "modelExecution": "not_tested", "roomId": selectedScope["roomId"] ?? "", "origin": selectedScope["origin"] ?? ""]) { _, new in new }
    }
}
