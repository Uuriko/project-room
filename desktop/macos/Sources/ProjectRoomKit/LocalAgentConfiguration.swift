import Foundation

public enum LocalAgentConfiguration {
    // Resolve the broker in the desktop process, not in the agent's possibly isolated HOME.
    // Only the path is exported; the connection nonce remains in the private broker file.
    public static func json(executable: URL, connection: URL) throws -> String {
        let config: [String: Any] = ["mcpServers": ["project-room-mac": [
            "command": executable.path, "args": ["--connection", connection.path]
        ]]]
        let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}
