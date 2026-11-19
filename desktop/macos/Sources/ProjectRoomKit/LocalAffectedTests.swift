import AppKit

/// Native action for one chosen checkout and Room work item.
@MainActor public final class LocalAffectedTests: NSObject {
    private let button = NSButton(title: "Run affected tests…", target: nil, action: nil)
    private let status = NSTextField(wrappingLabelWithString: "")
    private let window: NSWindow
    private let process = NativeSetupProcess()
    private var lastConnection: URL?
    private var lastFolder: URL?

    public override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 155),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        super.init()
        window.title = "Affected tests · Project Room"; window.isReleasedWhenClosed = false
        button.target = self; button.action = #selector(startOrCancel)
        button.bezelStyle = .rounded
        status.textColor = .secondaryLabelColor
        let content = NSStackView(views: [button, status]); content.orientation = .vertical
        content.alignment = .leading; content.spacing = 12; content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(content)
        status.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        NSLayoutConstraint.activate([content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 20),
            content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 20),
            content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -20)])
        window.center()
    }

    public func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    public func stop() { process.cancel() }

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
