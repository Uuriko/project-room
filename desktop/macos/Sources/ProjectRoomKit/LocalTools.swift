import Foundation
import CryptoKit
import ApplicationServices
import CoreGraphics
import Darwin

public struct LocalToolFailure: Error { public let code: String; init(_ code: String) { self.code = code } }

// Native-owned state. No WKWebView message handler can grant or execute these tools.
public final class LocalTools {
    private let lock = NSRecursiveLock()
    public let directory: URL
    private var enabled = false
    private var revision = 0
    private var active: [String: pid_t] = [:]
    private var stopReasons: [String: String] = [:]
    private var reserved = Set<String>()
    private let fixtureRoot: URL?
    public init(directory: URL? = nil, fixtureRoot: URL? = nil) throws {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Project Room/Local Tools")
        self.fixtureRoot = fixtureRoot
        try FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: self.directory.path)
    }
    @discardableResult public func setEnabled(_ value: Bool) -> Int {
        lock.lock(); defer { lock.unlock() }
        revision += 1; enabled = value
        if !value { for (id,pid) in active { stopReasons[id] = "paused"; kill(-pid, SIGKILL) } }
        return revision
    }
    public func status() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["enabled": enabled, "grantRevision": revision, "runningProcesses": active.count,
                "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(),
                "fullDiskAccess": "not_detected_check_system_settings", "automation": "per_application",
                "scope": "local_owner_tools", "remoteDeviceConnection": false]
    }
    private func authorize(_ expected: Int) throws {
        guard enabled else { throw LocalToolFailure("mac_tools_paused") }
        guard revision == expected else { throw LocalToolFailure("mac_grant_changed") }
    }
    private func path(_ value: Any?) throws -> URL {
        guard let text = value as? String, text.hasPrefix("/"), !text.contains("\0"), text.utf8.count < 4096 else { throw LocalToolFailure("invalid_absolute_path") }
        let url = URL(fileURLWithPath: text).standardizedFileURL
        if let root = fixtureRoot {
            let resolved = url.resolvingSymlinksInPath().path, base = root.resolvingSymlinksInPath().path
            guard resolved == base || resolved.hasPrefix(base + "/") else { throw LocalToolFailure("outside_acceptance_fixture") }
        }
        return url
    }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func read(_ url: URL) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 65536 else { throw LocalToolFailure("file_not_small_regular_text") }
        let data = try Data(contentsOf: url)
        guard data.count <= 65536 else { throw LocalToolFailure("file_too_large") }
        return data
    }
    private func operationURL(_ id: String) -> URL { directory.appendingPathComponent("operation-\(digest(Data(id.utf8))).json") }
    private func save(_ value: [String: Any], _ url: URL) throws {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let fd = Darwin.open(url.path, O_RDONLY); guard fd >= 0 else { throw LocalToolFailure("journal_unavailable") }
        defer { close(fd) }; guard fsync(fd) == 0 else { throw LocalToolFailure("journal_unavailable") }
        let parent = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
        guard parent >= 0 else { throw LocalToolFailure("journal_unavailable") }
        defer { close(parent) }; guard fsync(parent) == 0 else { throw LocalToolFailure("journal_unavailable") }
    }
    public func call(_ name: String, arguments: [String: Any], grantRevision: Int) throws -> [String: Any] {
        lock.lock()
        if name == "mac_status" { lock.unlock(); guard arguments.isEmpty else { throw LocalToolFailure("invalid_tool_arguments") }; return status() }
        do { try authorize(grantRevision) } catch { lock.unlock(); throw error }
        let allowed: [String: Set<String>] = [
            "mac_files_read": ["path"], "mac_files_write": ["requestId","path","text","expectedSHA256","expectedAbsent"],
            "mac_process_run": ["requestId","executable","arguments","cwd","timeoutMs"], "mac_process_cancel": ["requestId","targetRequestId"]]
        guard let keys = allowed[name], Set(arguments.keys).isSubset(of: keys) else { lock.unlock(); throw LocalToolFailure("invalid_tool_arguments") }
        if name == "mac_files_read" {
            defer { lock.unlock() }
            let url = try path(arguments["path"]), data = try read(url)
            guard let text = String(data: data, encoding: .utf8) else { throw LocalToolFailure("file_not_utf8") }
            return ["path": url.path, "text": text, "sha256": digest(data), "bytes": data.count]
        }
        guard let id = arguments["requestId"] as? String, !id.isEmpty, id.utf8.count <= 128 else { lock.unlock(); throw LocalToolFailure("request_id_required") }
        let basis: String
        do { basis = digest(try JSONSerialization.data(withJSONObject: ["tool": name, "arguments": arguments], options: [.sortedKeys])) }
        catch { lock.unlock(); throw LocalToolFailure("invalid_tool_arguments") }
        let record = operationURL(id)
        if let data = try? Data(contentsOf: record), let prior = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            defer { lock.unlock() }
            guard prior["basis"] as? String == basis else { throw LocalToolFailure("request_id_reused") }
            if let result = prior["result"] as? [String: Any] { return result.merging(["duplicate": true]) { _, new in new } }
            throw LocalToolFailure("operation_unconfirmed_reconcile_before_repeating")
        }
        guard !reserved.contains(id) else { lock.unlock(); throw LocalToolFailure("operation_running") }
        do { try save(["basis": basis, "state": "prepared"], record) } catch { lock.unlock(); throw error }
        reserved.insert(id)
        if name != "mac_process_run" {
            defer { reserved.remove(id); lock.unlock() }
            do {
                var result: [String: Any]
                if name == "mac_files_write" {
                    let url = try path(arguments["path"])
                    guard let text = arguments["text"] as? String, text.utf8.count <= 65536 else { throw LocalToolFailure("invalid_text") }
                    let exists = FileManager.default.fileExists(atPath: url.path)
                    if let expected = arguments["expectedSHA256"] as? String {
                        guard arguments["expectedAbsent"] == nil, exists, digest(try read(url)) == expected else { throw LocalToolFailure("file_version_changed") }
                    } else { guard arguments["expectedAbsent"] as? Bool == true, !exists else { throw LocalToolFailure("file_version_required") } }
                    let data = Data(text.utf8)
                    if arguments["expectedAbsent"] as? Bool == true {
                        let temporary = url.deletingLastPathComponent().appendingPathComponent(".projectroom-\(UUID().uuidString)")
                        let fd = Darwin.open(temporary.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
                        guard fd >= 0 else { throw LocalToolFailure("operation_unconfirmed_reconcile_before_repeating") }
                        let handle = FileHandle(fileDescriptor:fd,closeOnDealloc:false)
                        defer { close(fd); try? FileManager.default.removeItem(at:temporary) }
                        try handle.write(contentsOf:data); try handle.synchronize()
                        // Atomic absent-only publication; a file created after our read is preserved.
                        guard Darwin.link(temporary.path,url.path) == 0 else {
                            if errno == EEXIST { throw LocalToolFailure("file_version_changed") }
                            throw LocalToolFailure("operation_unconfirmed_reconcile_before_repeating")
                        }
                    } else { try data.write(to:url,options:.atomic) }
                    result = ["path": url.path, "sha256": digest(data), "bytes": data.count, "saved": true]
                } else {
                    guard let target = arguments["targetRequestId"] as? String else { throw LocalToolFailure("target_request_required") }
                    if let pid = active[target] { stopReasons[target] = "cancelled"; kill(-pid, SIGKILL); result = ["stopRequested": true, "targetRequestId": target] }
                    else { result = ["stopRequested": false, "targetRequestId": target, "state": "not_running"] }
                }
                try save(["basis": basis, "state": "completed", "result": result], record); return result
            } catch let failure as LocalToolFailure { try? FileManager.default.removeItem(at: record); throw failure }
            catch { throw LocalToolFailure("operation_unconfirmed_reconcile_before_repeating") }
        }
        lock.unlock()
        do {
            let result = try process(id, arguments, grantRevision)
            lock.lock(); defer { reserved.remove(id); lock.unlock() }
            try save(["basis": basis, "state": "completed", "result": result], record)
            return result
        } catch {
            lock.lock(); defer { reserved.remove(id); lock.unlock() }
            // A spawn refusal is known not to execute. An uncertain observation remains journaled.
            if let failure = error as? LocalToolFailure, ["invalid_process_arguments","outside_acceptance_fixture","mac_grant_changed","mac_tools_paused","process_could_not_start","invalid_absolute_path"].contains(failure.code) { try? FileManager.default.removeItem(at: record) }
            throw error
        }
    }
    private func process(_ id: String, _ args: [String: Any], _ grantRevision: Int) throws -> [String: Any] {
        guard let executable = args["executable"] as? String, executable.hasPrefix("/"), !executable.contains("\0"),
              let argv = args["arguments"] as? [String], argv.count <= 128, argv.allSatisfy({ !$0.contains("\0") && $0.utf8.count <= 8192 }),
              let timeout = args["timeoutMs"] as? Int, (100...300000).contains(timeout) else { throw LocalToolFailure("invalid_process_arguments") }
        let cwd = try path(args["cwd"])
        var actions: posix_spawn_file_actions_t?; var attributes: posix_spawnattr_t?
        posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
        defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
        let output = directory.appendingPathComponent("output-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw LocalToolFailure("process_could_not_start") }
        defer { try? FileManager.default.removeItem(at: output) }
        posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, output.path, O_WRONLY, 0o600)
        posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDERR_FILENO)
        posix_spawn_file_actions_addchdir_np(&actions, cwd.path)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)); posix_spawnattr_setpgroup(&attributes, 0)
        let environment = ["PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME=\(NSHomeDirectory())", "LANG=en_US.UTF-8", "TMPDIR=\(NSTemporaryDirectory())"]
        let argumentPointers = ([executable] + argv).map { strdup($0) } + [nil]
        let environmentPointers = environment.map { strdup($0) } + [nil]
        defer { for ptr in argumentPointers + environmentPointers { if let ptr { free(ptr) } } }
        var pid: pid_t = 0
        lock.lock()
        do { try authorize(grantRevision) } catch { lock.unlock(); throw error }
        let started = argumentPointers.withUnsafeBufferPointer { a in environmentPointers.withUnsafeBufferPointer { e in
            posix_spawn(&pid, executable, &actions, &attributes, UnsafeMutablePointer(mutating: a.baseAddress!), UnsafeMutablePointer(mutating: e.baseAddress!))
        } }
        guard started == 0 else { lock.unlock(); throw LocalToolFailure("process_could_not_start") }
        active[id] = pid; lock.unlock()
        defer { lock.lock(); active.removeValue(forKey: id); stopReasons.removeValue(forKey:id); lock.unlock() }
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        var status: Int32 = 0, stopped: String? = nil
        while true {
            let observed = waitpid(pid, &status, WNOHANG)
            if observed == pid { break }
            if observed < 0 { throw LocalToolFailure("process_outcome_unconfirmed") }
            lock.lock(); let revoked = !enabled || revision != grantRevision; lock.unlock()
            if revoked { stopped = "paused"; kill(-pid, SIGKILL) }
            else if Date() >= deadline { stopped = "timed_out"; kill(-pid, SIGKILL) }
            let size = (try? FileManager.default.attributesOfItem(atPath: output.path)[.size] as? NSNumber)?.intValue ?? 0
            if size > 65536 { stopped = "output_limit"; kill(-pid, SIGKILL) }
            Thread.sleep(forTimeInterval: 0.02)
        }
        // Clean up descendants even when the direct child exits first.
        kill(-pid, SIGKILL)
        let handle = try FileHandle(forReadingFrom: output); defer { try? handle.close() }
        let data = try handle.read(upToCount: 65536) ?? Data()
        let signal = status & 0x7f, exit = (status >> 8) & 0xff
        lock.lock(); if stopped == nil && signal != 0 { stopped = stopReasons[id] }; lock.unlock()
        return ["requestId": id, "state": stopped ?? (signal == 0 ? "exited" : "stopped"), "exitCode": signal == 0 ? Int(exit) : NSNull(), "signal": Int(signal), "output": String(decoding: data, as: UTF8.self), "outputTruncated": stopped == "output_limit"]
    }
}
