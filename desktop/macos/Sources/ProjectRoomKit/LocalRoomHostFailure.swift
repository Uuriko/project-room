// A closed local channel shared with run-codex-room. Never derive native UI
// guidance from stderr, provider errors, paths, or arbitrary status text.
enum LocalRoomHostFailure: String, CaseIterable {
    case profileLock = "profile_lock_requires_reconciliation"
    case login = "login_required"
    case invalidRuntime = "invalid_runtime"

    static func read(_ value: Any?) -> LocalRoomHostFailure? {
        guard let code = value as? String else { return nil }
        return LocalRoomHostFailure(rawValue: code)
    }
    static func fromWaitStatus(_ status: Int32?) -> LocalRoomHostFailure? {
        guard let status, status & 0x7f == 0 else { return nil }
        switch (status >> 8) & 0xff {
        case 70: return .profileLock
        case 71: return .login
        case 72: return .invalidRuntime
        default: return nil
        }
    }
    var message: String {
        switch self {
        case .profileLock: return "Agent profile is locked · reconcile the prior runtime"
        case .login: return "Sign in to the dedicated Codex account"
        case .invalidRuntime: return "Check the selected Codex runtime and profile"
        }
    }
}
