import Foundation
import WebKit

/// A local browser identity boundary, not a server role or permission grant.
public struct RoomProfile: Codable, Equatable {
    public let id: UUID
    public let name: String

    public init(id: UUID = UUID(), name: String) throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 60,
              trimmed.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else {
            throw ProfileError.invalidName
        }
        self.id = id
        self.name = trimmed
    }

    @MainActor public func websiteDataStore() -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: id)
    }
}

public enum ProfileError: Error { case invalidName, invalidRecord }

/// One atomic file per profile avoids lost updates between app instances.
/// Never replace an unreadable registry with an empty one or reuse a store ID.
public struct RoomProfileStore {
    public let directory: URL
    public init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Project Room/Profiles", isDirectory: true)
    }
    public func load() throws -> [RoomProfile] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.map { url in
                let decoded = try JSONDecoder().decode(RoomProfile.self, from: Data(contentsOf: url))
                guard url.deletingPathExtension().lastPathComponent == decoded.id.uuidString else { throw ProfileError.invalidRecord }
                return try RoomProfile(id: decoded.id, name: decoded.name)
            }.sorted { $0.name == $1.name ? $0.id.uuidString < $1.id.uuidString : $0.name < $1.name }
    }
    public func create(name: String) throws -> RoomProfile {
        let profile = try RoomProfile(name: name)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(profile.id.uuidString + ".json")
        try JSONEncoder().encode(profile).write(to: url, options: .atomic)
        return profile
    }
}
