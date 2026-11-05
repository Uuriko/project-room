@main struct LocalRoomHostFailureCheck {
    static func main() {
        let expected: [(Int32, LocalRoomHostFailure)] = [(70, .profileLock), (71, .login), (72, .invalidRuntime)]
        for (code, failure) in expected {
            precondition(LocalRoomHostFailure.fromWaitStatus(code << 8) == failure)
            precondition(LocalRoomHostFailure.read(failure.rawValue) == failure)
            precondition(!failure.message.isEmpty)
            precondition(!failure.message.contains("PRIVATE"))
        }
        for status: Int32 in [0, 1 << 8, 9, 15, (70 << 8) | 9, 255 << 8] {
            precondition(LocalRoomHostFailure.fromWaitStatus(status) == nil)
        }
        precondition(LocalRoomHostFailure.fromWaitStatus(nil) == nil)
        for value: Any in ["PRIVATE-ERROR-DETAIL", "__proto__", 70, ["code": "login_required"]] {
            precondition(LocalRoomHostFailure.read(value) == nil)
        }
        print("PASS native launch status accepts only the closed local codes and normal owned-child exits")
    }
}
