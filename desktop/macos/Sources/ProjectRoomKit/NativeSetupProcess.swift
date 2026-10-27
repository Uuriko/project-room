import Foundation
import Darwin

/// One bounded, cancellable setup child. JSON input goes through stdin; no
/// shell, credential arguments, environment inheritance, or diagnostic echo.
@MainActor public final class NativeSetupProcess {
    private var child: Process?
    private var timeout: Timer?
    public var isRunning: Bool { child != nil }
    public init() {}
    public func cancel() { if child?.isRunning == true { child?.terminate() } }
    public func start(node: URL, script: URL, input: [String: Any], onEvent: @escaping ([String: Any]) -> Void, onFinish: @escaping (Bool) -> Void) throws {
        guard child == nil else { throw LocalToolFailure("setup_already_running") }
        let bytes = try JSONSerialization.data(withJSONObject: input)
        guard bytes.count <= 16384 else { throw LocalToolFailure("setup_input_too_large") }
        let process = Process(), output = Pipe(), stdin = Pipe()
        process.executableURL = node; process.arguments = [script.path]
        process.environment = ["HOME": NSHomeDirectory(), "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "en_US.UTF-8", "TMPDIR": NSTemporaryDirectory()]
        process.standardInput = stdin; process.standardOutput = output; process.standardError = FileHandle.nullDevice
        try process.run(); child = process
        do { try stdin.fileHandleForWriting.write(contentsOf: bytes); try stdin.fileHandleForWriting.close() }
        catch { process.terminate(); child = nil; throw error }
        timeout = Timer.scheduledTimer(withTimeInterval: 330, repeats: false) { _ in if process.isRunning { process.terminate() } }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var buffer = Data(), failed = false
            var received = 0
            do {
                var bytes = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
                    if count == 0 { break }
                    if count < 0 {
                        if errno == EINTR { continue }
                        throw LocalToolFailure("setup_read_failed")
                    }
                    let data = Data(bytes.prefix(count))
                    buffer.append(data); received += count
                    if received > 65536 { failed = true; if process.isRunning { process.terminate() }; break }
                    while let newline = buffer.firstIndex(of: 10) {
                        let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
                        guard let event = try JSONSerialization.jsonObject(with: line) as? [String: Any] else { throw LocalToolFailure("invalid_setup_output") }
                        DispatchQueue.main.async { onEvent(event) }
                    }
                }
            } catch { failed = true; if process.isRunning { process.terminate() } }
            process.waitUntilExit()
            let success = !failed && buffer.isEmpty && process.terminationStatus == 0
            DispatchQueue.main.async {
                self?.timeout?.invalidate(); self?.timeout = nil; self?.child = nil
                onFinish(success)
            }
        }
    }
}
