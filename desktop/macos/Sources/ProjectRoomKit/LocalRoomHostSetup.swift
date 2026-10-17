import Foundation
import Darwin

/// Converts explicit native selections into an app-owned configuration. No
/// credentials are copied, no process is started, and no imported file is edited.
public enum LocalRoomHostSetup {
    public struct Selection {
        public let node, script, codex, workspace, profile, connection: URL
        public let allowWrites: Bool
        public init(node: URL, script: URL, codex: URL, workspace: URL, profile: URL, connection: URL, allowWrites: Bool) {
            self.node = node; self.script = script; self.codex = codex
            self.workspace = workspace; self.profile = profile; self.connection = connection; self.allowWrites = allowWrites
        }
    }
    private static func privateItem(_ url: URL, directory: Bool) throws {
        let a = try FileManager.default.attributesOfItem(atPath: url.path)
        guard a[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((a[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0
        else { throw LocalToolFailure("setup_private_folder_required") }
    }
    public static func save(_ selection: Selection, directory: URL) throws -> URL {
        let fm = FileManager.default
        let workspace = selection.workspace.resolvingSymlinksInPath().standardizedFileURL
        let profile = selection.profile.resolvingSymlinksInPath().standardizedFileURL
        let ordinary = fm.homeDirectoryForCurrentUser.appendingPathComponent(".codex").resolvingSymlinksInPath()
        let ambient = ProcessInfo.processInfo.environment["CODEX_HOME"].map { URL(fileURLWithPath: $0).resolvingSymlinksInPath() }
        guard profile.path != workspace.path, !profile.path.hasPrefix(workspace.path + "/"),
              profile.path != ordinary.path, !profile.path.hasPrefix(ordinary.path + "/"),
              profile.path != fm.homeDirectoryForCurrentUser.path,
              ambient.map({ profile.path != $0.path && !profile.path.hasPrefix($0.path + "/") }) ?? true else { throw LocalToolFailure("setup_dedicated_profile_required") }
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: workspace.path, isDirectory: &isDirectory), isDirectory.boolValue,
              fm.isExecutableFile(atPath: selection.node.path), fm.isExecutableFile(atPath: selection.codex.path),
              fm.isReadableFile(atPath: selection.script.path) else { throw LocalToolFailure("setup_tools_unavailable") }
        // Existing profile only: signing in is a separate explicit operation.
        try privateItem(selection.profile, directory: true)
        try privateItem(selection.connection, directory: true)
        let connectionFile = selection.connection.appendingPathComponent("connection.json")
        try privateItem(connectionFile, directory: false)
        guard ((try fm.attributesOfItem(atPath: connectionFile.path))[.size] as? NSNumber)?.intValue ?? 4097 <= 4096
        else { throw LocalToolFailure("invalid_room_connection") }
        let bytes = try Data(contentsOf: connectionFile)
        guard bytes.count <= 4096, let identity = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              identity["version"] as? Int == 1,
              ["origin", "roomId", "memberId", "token"].allSatisfy({ !(identity[$0] as? String ?? "").isEmpty })
        else { throw LocalToolFailure("invalid_room_connection") }
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try privateItem(directory, directory: true)
        let owned = directory.appendingPathComponent("setup-\(UUID().uuidString)")
        try fm.createDirectory(at: owned, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        do {
            func write(_ data: Data, _ url: URL) throws {
                try data.write(to: url, options: .atomic)
                try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            }
            let runtime = owned.appendingPathComponent("runtime.json")
            try write(JSONSerialization.data(withJSONObject: ["command": selection.codex.path,
                "cwd": workspace.path, "codexHome": profile.path,
                "policy": ["approvalPolicy": "never", "sandbox": selection.allowWrites ? "workspace-write" : "read-only"]], options: [.sortedKeys]), runtime)
            let manifest = RoomHostManifest(version: 1, node: selection.node.path, script: selection.script.path,
                runtimeConfig: runtime.path, roomConnection: selection.connection.path)
            let url = owned.appendingPathComponent("host.json")
            try write(JSONEncoder().encode(manifest), url)
            _ = try RoomHostManifest.read(url)
            return url
        } catch { try? fm.removeItem(at: owned); throw error }
    }
}
