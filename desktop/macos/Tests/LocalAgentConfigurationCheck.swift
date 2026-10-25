import Foundation

@main struct LocalAgentConfigurationCheck {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let executable = root.appendingPathComponent("Project Room helper")
        // A real child proves that spaces and quotes survive as arguments, with a different HOME.
        try Data("#!/bin/sh\nprintf '%s\\n' \"$HOME\" \"$1\" \"$2\"\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let connection = root.appendingPathComponent("Owner's Mac \"connection\".json")
        let text = try LocalAgentConfiguration.json(executable: executable, connection: connection)
        let decoded = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        let server = (decoded["mcpServers"] as! [String: Any])["project-room-mac"] as! [String: Any]
        precondition(Set(server.keys) == ["command", "args"])
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: server["command"] as! String)
        process.arguments = server["args"] as? [String]
        process.environment = ["HOME": root.appendingPathComponent("isolated-agent-home").path]
        process.standardOutput = output
        try process.run(); process.waitUntilExit()
        let lines = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(separator: "\n").map(String.init)
        precondition(process.terminationStatus == 0)
        precondition(lines == [process.environment!["HOME"]!, "--connection", connection.path])
        print("PASS copied configuration preserves native connection across isolated HOME and quoted paths")
    }
}
