import Foundation

public enum LocalHostReadiness {
    // Selected configuration describes exposure, not a successful MCP handshake.
    public static func toolConfiguration(_ url: URL) -> [String: String] {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 65536,
              let bytes = try? Data(contentsOf: url), bytes.count <= 65536,
              let runtime = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        else { return ["mode": "unknown"] }
        guard let value = runtime["macTools"] else { return ["mode": "none"] }
        guard let tools = value as? [String: Any], let command = tools["command"] as? String,
              command.hasPrefix("/"), let connection = tools["connection"] as? String, connection.hasPrefix("/"),
              tools["inputApproval"] == nil || ["approve", "prompt"].contains(tools["inputApproval"] as? String ?? "")
        else { return ["mode": "unknown"] }
        return ["mode": tools["inputApproval"] as? String == "approve" ? "control" : "approval_required", "connection": connection]
    }

    public static func notice(host: [String: Any], local: [String: Any], connection: String) -> String? {
        guard host["configured"] as? Bool == true else { return "Set up this Mac’s agent to work from Conversation." }
        if host["stopping"] as? Bool == true { return "This Mac’s agent is stopping. Wait before starting it again." }
        guard host["running"] as? Bool == true else {
            return host["lastExit"] as? String == "unconfirmed"
                ? "This Mac’s agent ended without a confirmed stop. Review its status in My Mac before restarting."
                : "This Mac’s agent is stopped. Start it in My Mac."
        }
        guard host["statusFresh"] as? Bool == true else { return "This Mac’s agent status is unavailable. Check My Mac." }
        if host["credentials"] as? String == "login_required" { return "This Mac’s agent needs sign-in. Stop it in My Mac, then choose Set up agent." }
        switch host["phase"] as? String {
        case "retrying_room": return "This Mac’s agent is reconnecting to its room. Check the connection in My Mac."
        case "recovery_pending": return "This Mac’s agent is reconciling earlier work. Open My Mac for status."
        case "stopped": return "This Mac’s agent is stopping. Wait before starting it again."
        case "running", "watching_room", "protocol_qualified", "settled": break
        default: return "This Mac’s agent is checking its connection and sign-in."
        }
        guard host["protocol"] as? String == "qualified",
              ["present", "not_required"].contains(host["credentials"] as? String ?? "")
        else { return "This Mac’s agent is checking its connection and sign-in." }
        let tools = host["macTools"] as? [String: String] ?? [:]
        switch tools["mode"] {
        case "none": return "For computer tasks, stop this agent and connect Mac tools in My Mac."
        case "control", "approval_required": break
        default: return "This Mac’s tool configuration could not be checked. Review setup in My Mac."
        }
        guard tools["connection"] == connection else { return "This agent uses a different Mac tool connection. Stop it and reconnect tools in My Mac." }
        guard local["enabled"] as? Bool == true else { return "This Mac’s tools are paused. Enable them in My Mac for computer tasks." }
        let capabilities = local["capabilities"] as? [[String: Any]] ?? []
        for id in ["app_state", "screenshots", "app_input"] {
            guard let capability = capabilities.first(where: { $0["id"] as? String == id }) else {
                return "This Mac’s tool status is unavailable. Check My Mac."
            }
            if capability["state"] as? String != "preflight_passed" {
                return "\(capability["label"] as? String ?? "Mac tools"): \(capability["message"] as? String ?? "Check My Mac")."
            }
        }
        if tools["mode"] == "approval_required" { return "App control needs approval. Stop this agent before changing Mac tool access in My Mac." }
        return nil // No known blocker is not a claim of verified model execution.
    }
}
