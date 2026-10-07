import Foundation
import Security
import Darwin

private func unixAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw LocalToolFailure("socket_path_too_long") }
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
}
private func socketWrite(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { raw in
        var sent = 0
        while sent < data.count {
            let count = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), data.count - sent)
            guard count > 0 else { throw LocalToolFailure("mac_connection_lost") }; sent += count
        }
    }
}
private func socketRead(_ fd: Int32) throws -> Data {
    var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
    while result.count <= 1048576 {
        let count = Darwin.read(fd, &buffer, buffer.count)
        guard count > 0 else { throw LocalToolFailure("mac_response_unconfirmed") }
        if let end = buffer[..<count].firstIndex(of: 10) { result.append(contentsOf: buffer[..<end]); return result }
        result.append(contentsOf: buffer[..<count])
    }
    throw LocalToolFailure("mac_request_too_large")
}
private func configureSocket(_ fd: Int32, timeout: Int = 310) {
    var noSignal: Int32 = 1; setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    var time = timeval(tv_sec: timeout, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &time, socklen_t(MemoryLayout<timeval>.size))
}

// Local development IPC. Owner-only directory/socket + nonce + OS peer UID.
// No TCP listener and no WebKit bridge. Production device enrollment is separate.
public final class LocalToolConnection {
    private var listener: Int32 = -1
    private var ownerLock: Int32 = -1
    private let service: LocalTools
    private let token: String
    private let socketURL: URL
    public let connectionURL: URL
    private let slots = DispatchSemaphore(value: 8)
    public init(service: LocalTools) throws {
        self.service = service
        socketURL = service.directory.appendingPathComponent("tools.sock")
        connectionURL = service.directory.appendingPathComponent("connection.json")
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LocalToolFailure("secure_random_unavailable") }
        token = Data(bytes).base64EncodedString()
        ownerLock = Darwin.open(service.directory.appendingPathComponent("endpoint.lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard ownerLock >= 0 else { throw LocalToolFailure("socket_unavailable") }
        guard flock(ownerLock, LOCK_EX | LOCK_NB) == 0 else { close(ownerLock); ownerLock = -1; throw LocalToolFailure("mac_tools_already_running") }
        // Never replace a live endpoint from another instance.
        if FileManager.default.fileExists(atPath: socketURL.path) {
            let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0); defer { close(probe) }
            var address = try unixAddress(socketURL.path)
            let running = withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0 } }
            guard !running else { throw LocalToolFailure("mac_tools_already_running") }
            try FileManager.default.removeItem(at: socketURL)
        }
        listener = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw LocalToolFailure("socket_unavailable") }
        var address = try unixAddress(socketURL.path)
        let bound = withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, chmod(socketURL.path, 0o600) == 0, listen(listener, 8) == 0 else { close(listener); listener = -1; throw LocalToolFailure("socket_unavailable") }
        try publish()
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            while true {
                let fd = accept(listener, nil, nil); if fd < 0 { break }
                if slots.wait(timeout: .now()) != .success { close(fd); continue }
                DispatchQueue.global(qos: .userInitiated).async { [self] in defer { close(fd); slots.signal() }; respond(fd) }
            }
        }
    }
    deinit { if ownerLock >= 0 { close(ownerLock) } }
    public func publish() throws {
        let value: [String: Any] = ["socketPath": socketURL.path, "token": token, "grantRevision": service.status()["grantRevision"]!, "protocolVersion": 1]
        try JSONSerialization.data(withJSONObject: value).write(to: connectionURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: connectionURL.path)
    }
    public func stop() {
        service.setEnabled(false)
        if listener >= 0 { shutdown(listener, SHUT_RDWR); close(listener); listener = -1 }
        try? FileManager.default.removeItem(at: socketURL); try? FileManager.default.removeItem(at: connectionURL)
        if ownerLock >= 0 { close(ownerLock); ownerLock = -1 }
    }
    private func respond(_ fd: Int32) {
        configureSocket(fd, timeout: 10)
        var result: [String: Any]
        do {
            var uid: uid_t = 0, gid: gid_t = 0
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw LocalToolFailure("mac_connection_denied") }
            let data = try socketRead(fd)
            guard let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(request.keys) == ["token","tool","arguments","grantRevision"], request["token"] as? String == token,
                  let name = request["tool"] as? String, let args = request["arguments"] as? [String: Any], let revision = request["grantRevision"] as? Int else { throw LocalToolFailure("mac_connection_denied") }
            result = ["ok": true, "result": try service.call(name, arguments: args, grantRevision: revision)]
        } catch let failure as LocalToolFailure { result = ["ok": false, "error": failure.code] }
        catch { result = ["ok": false, "error": "mac_operation_failed"] }
        if var data = try? JSONSerialization.data(withJSONObject: result) { data.append(10); try? socketWrite(fd, data) }
    }
    public static func call(connectionURL: URL, name: String, arguments: [String: Any]) throws -> [String: Any] {
        let attributes = try FileManager.default.attributesOfItem(atPath: connectionURL.path)
        guard (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0,
              let connection = try JSONSerialization.jsonObject(with: Data(contentsOf: connectionURL)) as? [String: Any],
              let path = connection["socketPath"] as? String, let token = connection["token"] as? String,
              let revision = connection["grantRevision"] as? Int else { throw LocalToolFailure("mac_connection_denied") }
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { throw LocalToolFailure("socket_unavailable") }
        defer { close(fd) }; configureSocket(fd)
        var address = try unixAddress(path)
        let connected = withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard connected == 0 else { throw LocalToolFailure("open_project_room_mac") }
        var uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw LocalToolFailure("mac_connection_denied") }
        var data = try JSONSerialization.data(withJSONObject: ["token":token,"tool":name,"arguments":arguments,"grantRevision":revision]); data.append(10)
        guard data.count <= 1048576 else { throw LocalToolFailure("mac_request_too_large") }
        try socketWrite(fd, data)
        guard let reply = try JSONSerialization.jsonObject(with: socketRead(fd)) as? [String: Any] else { throw LocalToolFailure("mac_response_unconfirmed") }
        guard reply["ok"] as? Bool == true, let result = reply["result"] as? [String: Any] else { throw LocalToolFailure(reply["error"] as? String ?? "mac_operation_failed") }
        return result
    }
}
