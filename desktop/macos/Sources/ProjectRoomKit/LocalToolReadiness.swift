import Foundation

// A local preflight is a diagnostic, never an execution grant or proof that a
// particular file, app, provider account or room can complete an operation.
public enum LocalToolReadiness {
    public static func capabilities(enabled: Bool, accessibility: Bool, screenCapture: Bool) -> [[String: Any]] {
        let groups: [(String, String, [String], String?)] = [
            ("files_and_processes", "Files and programs", ["mac_files_read", "mac_files_write", "mac_process_run", "mac_process_cancel"], nil),
            ("app_state", "Read app state", ["mac_app_state"], accessibility ? nil : "accessibility_permission_required"),
            ("screenshots", "Capture a window", ["mac_screenshot"], screenCapture ? nil : "screen_capture_permission_required"),
            ("app_input", "Type, click and scroll", ["mac_input"], accessibility ? nil : "accessibility_permission_required")
        ]
        return groups.map { id, label, tools, permission in
            let blockers = (enabled ? [] : ["mac_tools_paused"]) + (permission.map { [$0] } ?? [])
            let nextStep: String
            switch blockers.first {
            case "mac_tools_paused": nextStep = "Enable local tools"
            case "accessibility_permission_required": nextStep = "Allow Accessibility in macOS permissions"
            case "screen_capture_permission_required": nextStep = "Allow Screen Recording in macOS permissions"
            default: nextStep = "Local checks passed"
            }
            return ["id": id, "label": label, "tools": tools,
                    "state": blockers.isEmpty ? "preflight_passed" : "blocked",
                    "blockers": blockers, "message": nextStep]
        }
    }
    public static func summary(_ capabilities: [[String: Any]]) -> String {
        capabilities.map { "\($0["label"] as? String ?? "Local capability"): \($0["message"] as? String ?? "Status unavailable")" }.joined(separator: "\n")
    }
}
