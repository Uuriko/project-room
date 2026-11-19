import AppKit
import CryptoKit

/// Native action for one chosen checkout and Room work item.
@MainActor public final class LocalAffectedTests: NSObject {
    private let button = NSButton(title: "Run affected tests…", target: nil, action: nil)
    private let receiverButton = NSButton(title: "Start Room test receiver…", target: nil, action: nil)
    private let receiverStatus = NSTextField(wrappingLabelWithString: "Receiver stopped.")
    private let receiver = NativeSetupProcess()
    private var stoppingReceiver = false
    private let status = NSTextField(wrappingLabelWithString: "")
    private let window: NSWindow
    private let process = NativeSetupProcess()
    private var lastConnection: URL?
    private var lastFolder: URL?

    public override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 230),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Affected tests · Project Room"; window.isReleasedWhenClosed = false
        button.target = self; button.action = #selector(startOrCancel)
        button.bezelStyle = .rounded
        status.textColor = .secondaryLabelColor
        receiverButton.target = self; receiverButton.action = #selector(startOrStopReceiver)
        receiverButton.bezelStyle = .rounded
        receiverStatus.textColor = .secondaryLabelColor
        let content = NSStackView(views: [button, status, receiverButton, receiverStatus]); content.orientation = .vertical
        content.alignment = .leading; content.spacing = 12; content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(content)
        status.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        receiverStatus.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        NSLayoutConstraint.activate([content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
            content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
            content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20)])
        window.center()
    }

    public func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    public func stop() { process.cancel(); receiver.cancel() }

    @objc private func startOrStopReceiver() {
        if receiver.isRunning {
            stoppingReceiver = true
            receiverButton.isEnabled = false
            receiverStatus.stringValue = "Stopping the Room test receiver…"
            receiver.cancel()
            return
        }
        let picker = NSOpenPanel()
        picker.title = "Choose the approved affected-test policy"
        picker.canChooseFiles = true; picker.canChooseDirectories = false
        picker.allowsMultipleSelection = false
        picker.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let policy = picker.url else { return }
            self.chooseReceiverConnection(policy)
        }
    }

    private func chooseReceiverConnection(_ policy: URL) {
        let picker = NSOpenPanel()
        picker.title = "Choose the receiver's saved Room connection.json"
        picker.canChooseFiles = true; picker.canChooseDirectories = false
        picker.allowsMultipleSelection = false; picker.directoryURL = lastConnection?.deletingLastPathComponent()
        picker.beginSheetModal(for: window) { [weak self] result in
            guard let self, result == .OK, let connection = picker.url else { return }
            self.confirmReceiver(policy, connection: connection)
        }
    }

    private func confirmReceiver(_ policy: URL, connection: URL) {
        guard connection.lastPathComponent == "connection.json",
              let bytes = try? FileHandle(forReadingFrom: policy).read(upToCount: 8193), bytes.count <= 8192,
              let scope = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let origin = scope["origin"] as? String, let item = scope["workItemId"] as? String,
              let room = scope["roomId"] as? String, let member = scope["memberId"] as? String,
              let head = scope["head"] as? String, let base = scope["base"] as? String,
              let requesters = scope["requesters"] as? [String], let worktree = scope["worktree"] as? String else {
            receiverStatus.stringValue = "Choose an affected-test policy and a saved connection.json."
            return
        }
        let checks = (scope["checks"] as? [String] ?? ["affected"]).joined(separator: ", ")
        let dialog = NSAlert()
        dialog.messageText = "Start the Room check receiver?"
        dialog.informativeText = """
        Run approved checks from the pinned checkout as your Mac user while the app is open.
        Checks: \(checks)

        \(worktree)
        Head: \(head)
        Baseline: \(base)
        \(origin) · \(room) · \(item)
        Receiving as \(member)
        Allowed requesters: \(requesters.joined(separator: ", "))
        """
        let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        dialog.addButton(withTitle: "Start receiver")
        dialog.addButton(withTitle: "Cancel")
        dialog.beginSheetModal(for: window) { [weak self] result in
            if result == .alertFirstButtonReturn { self?.runReceiver(policy, connection: connection, approvalDigest: digest) }
        }
    }

    private func runReceiver(_ policy: URL, connection: URL, approvalDigest: String) {
        guard let node = LocalRoomHostSetup.installedExecutable("node"),
              let script = Bundle.main.resourceURL?.appendingPathComponent("room-runtime/scripts/run-desktop-affected-room.mjs"),
              FileManager.default.isReadableFile(atPath: script.path) else {
            receiverStatus.stringValue = "Node or the Room test receiver is unavailable."
            return
        }
        stoppingReceiver = false
        receiverStatus.stringValue = "Checking pinned worktree and Commons connection…"
        do {
            try receiver.startWatcher(node: URL(fileURLWithPath: node), script: script, policy: policy,
                connection: connection.deletingLastPathComponent(), approvalDigest: approvalDigest, onEvent: { [weak self] event in
                    guard let self, !self.stoppingReceiver else { return }
                    if event["status"] as? String == "watching", let head = event["head"] as? String {
                        self.receiverStatus.stringValue = "Listening for mac affected \(head)"
                    } else if let sequence = event["sequence"] as? Int {
                        self.receiverStatus.stringValue = "Listening · last test evidence posted at Room sequence \(sequence)."
                    }
                }, onFinish: { [weak self] success in
                    guard let self else { return }
                    self.receiverButton.title = "Start Room test receiver…"
                    self.receiverButton.isEnabled = true
                    self.receiverStatus.stringValue = self.stoppingReceiver || success
                        ? "Receiver stopped." : "Receiver ended. Check the approved policy and saved connection."
                    self.stoppingReceiver = false
                })
            receiverButton.title = "Stop Room test receiver"
        } catch { receiverStatus.stringValue = "Could not start the Room test receiver." }
    }

    @objc private func startOrCancel() {
        if process.isRunning { process.cancel(); status.stringValue = "Stopping local test run…"; return }
        let picker = NSOpenPanel()
        picker.title = "Choose the active Git worktree"
        picker.canChooseFiles = false; picker.canChooseDirectories = true
        picker.allowsMultipleSelection = false; picker.directoryURL = lastFolder
        picker.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let folder = picker.url else { return }
            self.lastFolder = folder
            if let connection = self.lastConnection { self.confirm(folder, connection: connection) }
            else { self.chooseConnection(folder) }
        }
    }

    private func chooseConnection(_ folder: URL) {
        let picker = NSOpenPanel()
        picker.title = "Choose the saved Room connection.json"
        picker.canChooseFiles = true; picker.canChooseDirectories = false
        picker.allowsMultipleSelection = false
        picker.directoryURL = lastConnection?.deletingLastPathComponent()
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/share/project-room")
        picker.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let file = picker.url else { return }
            self.confirm(folder, connection: file)
        }
    }

    private func confirm(_ folder: URL, connection: URL) {
        guard connection.lastPathComponent == "connection.json",
              let bytes = try? Data(contentsOf: connection), bytes.count <= 4096,
              let scope = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              let origin = scope["origin"] as? String, let room = scope["roomId"] as? String,
              let member = scope["memberId"] as? String else {
            status.stringValue = "Choose a saved Project Room connection.json."
            lastConnection = nil
            return
        }
        let dialog = NSAlert()
        dialog.messageText = "Run affected tests and post evidence"
        dialog.informativeText = "\(folder.path)\n\n\(room) at \(origin)\nPosting as \(member)"
        let work = NSTextField(); work.placeholderString = "Work item ID"
        work.setAccessibilityLabel("Work item ID")
        let base = NSTextField(string: "origin/main"); base.setAccessibilityLabel("Compare against")
        let fields = NSStackView(views: [NSTextField(labelWithString: "Work item ID"), work,
                                         NSTextField(labelWithString: "Compare against"), base])
        fields.frame = NSRect(x: 0, y: 0, width: 350, height: 102)
        fields.orientation = .vertical; fields.alignment = .leading; fields.spacing = 7
        work.widthAnchor.constraint(equalToConstant: 350).isActive = true
        base.widthAnchor.constraint(equalToConstant: 350).isActive = true
        dialog.accessoryView = fields
        dialog.addButton(withTitle: "Run and post")
        dialog.addButton(withTitle: "Cancel")
        dialog.addButton(withTitle: "Change connection…")
        dialog.window.initialFirstResponder = work
        dialog.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            if response == .alertThirdButtonReturn { self.chooseConnection(folder); return }
            guard response == .alertFirstButtonReturn else { return }
            self.lastConnection = connection
            self.run(["worktree": folder.path, "connection": connection.deletingLastPathComponent().path,
                      "origin": origin, "roomId": room, "memberId": member,
                      "workItemId": work.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
                      "base": base.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)])
        }
    }

    private func run(_ input: [String: Any]) {
        guard let node = LocalRoomHostSetup.installedExecutable("node"),
              let script = Bundle.main.resourceURL?.appendingPathComponent("room-runtime/scripts/desktop-affected.mjs"),
              FileManager.default.isReadableFile(atPath: script.path) else {
            status.stringValue = "Node or the desktop test runner is unavailable."
            return
        }
        status.stringValue = "Checking worktree and Room access…"
        do {
            var reported = false
            try process.start(node: URL(fileURLWithPath: node), script: script, input: input, onEvent: { [weak self] event in
                guard let self else { return }
                switch event["phase"] as? String {
                case "running": self.status.stringValue = "Running affected tests on this Mac…"
                case "finished":
                    reported = true
                    let evidence = event["evidence"] as? [String: Any]
                    let result = evidence?["status"] as? String ?? "unknown"
                    if event["recorded"] as? Bool == true, let sequence = event["sequence"] as? Int {
                        self.status.stringValue = "\(result.capitalized) · evidence posted at Room sequence \(sequence)."
                    } else {
                        self.status.stringValue = "\(result.capitalized) · Room receipt unconfirmed. Check operation \(event["operationId"] as? String ?? "unknown")."
                    }
                case "error":
                    reported = true
                    self.status.stringValue = "Could not run or record the check (\(event["code"] as? String ?? "unknown"))."
                default: break
                }
            }, onFinish: { [weak self] _ in
                guard let self else { return }
                self.button.title = "Run affected tests…"
                if !reported { self.status.stringValue = "Run ended before evidence was confirmed." }
            })
            button.title = "Cancel affected tests"
        } catch { status.stringValue = "Could not start the local test runner." }
    }
}
