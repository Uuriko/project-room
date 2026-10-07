// Local-only actual WKWebView acceptance runner. Never shipped in the app bundle.
import AppKit
import WebKit
import ProjectRoomKit

@MainActor final class Acceptance: NSObject, NSApplicationDelegate {
    var room: RoomWindow?
    let url: URL
    let script: String
    init(url: URL, script: String) { self.url = url; self.script = script }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        let downloadDirectory: URL? = args.firstIndex(of: "--download-directory").flatMap { index in
            index + 1 < args.count ? URL(fileURLWithPath: args[index + 1], isDirectory: true) : nil
        }
        room = RoomWindow(url: url, isolated: true, acceptanceDownloadDestination: downloadDirectory.map { directory in
            { filename in directory.appendingPathComponent(filename) }
        })
        room?.show()
        Task { @MainActor in
            do {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                guard let room else { exit(1) }
                let result = try await room.webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
                print("WK_ACCEPTANCE \(String(describing: result))")
                if let output = CommandLine.arguments.firstIndex(of: "--screenshot"), output + 1 < CommandLine.arguments.count {
                    let shot = try await room.webView.takeSnapshot(configuration: nil)
                    if let tiff = shot.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let data = bitmap.representation(using: .png, properties: [:]) {
                        try data.write(to: URL(fileURLWithPath: CommandLine.arguments[output + 1]))
                    }
                }
                if let index = args.firstIndex(of: "--expect-downloads"), index + 1 < args.count, let count = Int(args[index + 1]) {
                    for _ in 0..<100 {
                        if room.completedDownloadCount >= count || room.failedDownloadCount > 0 { break }
                        try await Task.sleep(nanoseconds: 100_000_000)
                    }
                    guard room.completedDownloadCount == count, room.failedDownloadCount == 0 else {
                        fatalError("Downloads did not finish: \(room.completedDownloadCount) saved, \(room.failedDownloadCount) failed")
                    }
                    print("WK_DOWNLOADS \(count) finished")
                }
                let activeURL = room.webView.url
                let draft = try await room.webView.evaluateJavaScript("document.querySelector('#message-input')?.value ?? null") as? String
                room.window.performClose(nil)
                guard !room.window.isVisible else { fatalError("Close failed") }
                room.show()
                guard room.window.isVisible && room.webView.url == activeURL else { fatalError("Return lost context") }
                let returnedDraft = try await room.webView.evaluateJavaScript("document.querySelector('#message-input')?.value ?? null") as? String
                guard draft == returnedDraft else { fatalError("Close lost draft") }
                print("WK_CLOSE_REOPEN passed")
                exit(0)
            } catch { fputs("WK_ACCEPTANCE_FAILED \(error)\n", stderr); exit(1) }
        }
    }
}
try MainActor.assumeIsolated {
let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
    fputs("Usage: RoomAcceptance http://127.0.0.1:PORT script.js [--screenshot output.png]\n", stderr); exit(2)
}
let script = try String(contentsOfFile: args[2], encoding: .utf8)
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Acceptance(url: url, script: script)
app.delegate = delegate
app.run()

}
