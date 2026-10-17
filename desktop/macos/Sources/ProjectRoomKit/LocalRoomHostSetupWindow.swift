import AppKit

@MainActor final class LocalRoomHostSetupWindow: NSObject, NSTextFieldDelegate {
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 500), styleMask: [.titled], backing: .buffered, defer: false)
    private let operation = NativeSetupProcess()
    private let target = NSTextField()
    private let joinButton = NSButton(title: "Connect room", target: nil, action: nil)
    private let loginButton = NSButton(title: "Sign in to provider", target: nil, action: nil)
    private let saveButton = NSButton(title: "Save setup", target: nil, action: nil)
    private var advancedRows: [NSView] = []
    private var choosingButtons: [NSButton] = []
    private var preview: String?
    private var previewTarget: String?
    private var connectedTarget: String?
    private var closing = false
    private let managed = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Project Room/Room Host")
    private var fields: [NSTextField] = []
    private let issue = NSTextField(wrappingLabelWithString: "")
    private let writes = NSButton(checkboxWithTitle: "Allow changes inside the selected workspace", target: nil, action: nil)
    private let host: LocalRoomHost
    private let completion: () -> Void
    init(host: LocalRoomHost, completion: @escaping () -> Void) {
        self.host = host; self.completion = completion
        super.init()
        panel.title = "Set up your room agent"
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let note = NSTextField(wrappingLabelWithString: "Connect a room, choose a workspace, then sign in to your provider. Installed Node and Codex tools are required for this development build; use Advanced if they are not detected.")
        stack.addArrangedSubview(note); note.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        target.delegate = self
        target.placeholderString = "Paste a room or invitation link"; target.setAccessibilityLabel("Room or invitation link")
        joinButton.target = self; joinButton.action = #selector(connectRoom); joinButton.bezelStyle = .rounded
        let joinRow = NSStackView(views: [target, joinButton]); joinRow.spacing = 8
        stack.addArrangedSubview(joinRow); joinRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let advanced = NSButton(checkboxWithTitle: "Advanced setup", target: self, action: #selector(toggleAdvanced(_:)))
        stack.addArrangedSubview(advanced)
        let labels = ["Room connection folder", "Workspace", "Dedicated Codex profile", "Node executable", "Room host script", "Codex executable"]
        for (index, label) in labels.enumerated() {
            let field = NSTextField(); field.placeholderString = label; field.isEditable = false
            field.setAccessibilityLabel(label); field.lineBreakMode = .byTruncatingMiddle
            field.setContentHuggingPriority(.defaultLow, for: .horizontal)
            field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let button = NSButton(title: "Choose…", target: self, action: #selector(choose(_:))); button.tag = index; button.bezelStyle = .rounded
            let caption = NSTextField(labelWithString: label); caption.font = .systemFont(ofSize: 12)
            caption.widthAnchor.constraint(equalToConstant: 155).isActive = true
            let row = NSStackView(views: [caption, field, button]); row.spacing = 8
            stack.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            fields.append(field); choosingButtons.append(button)
            if index != 1 { advancedRows.append(row); row.isHidden = true }
        }
        let fm = FileManager.default
        fields[3].stringValue = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: fm.isExecutableFile(atPath:)) ?? ""
        fields[5].stringValue = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"].first(where: fm.isExecutableFile(atPath:)) ?? ""
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("room-runtime/scripts/run-codex-room.mjs"), fm.isReadableFile(atPath: bundled.path) { fields[4].stringValue = bundled.path }
        fields[2].stringValue = managed.appendingPathComponent("Provider Profile").path
        loginButton.target = self; loginButton.action = #selector(signIn); loginButton.bezelStyle = .rounded
        stack.addArrangedSubview(loginButton)
        stack.addArrangedSubview(writes)
        let permissions = NSTextField(wrappingLabelWithString: "Computer control is separate. After saving, use Connect Mac tools to choose observation or app control. Saving does not start an agent.")
        permissions.textColor = .secondaryLabelColor; stack.addArrangedSubview(permissions); permissions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        issue.textColor = .systemRed; stack.addArrangedSubview(issue); issue.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        saveButton.target = self; saveButton.action = #selector(saveSetup); saveButton.bezelStyle = .rounded
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelSetup)); cancel.bezelStyle = .rounded; cancel.keyEquivalent = "\u{1b}"
        stack.addArrangedSubview(NSStackView(views: [cancel, saveButton]))
        panel.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 24)])
    }
    func show(on parent: NSWindow) { parent.beginSheet(panel) }
    @objc private func choose(_ sender: NSButton) {
        let picker = NSOpenPanel(); picker.canChooseDirectories = sender.tag < 3; picker.canChooseFiles = sender.tag >= 3
        picker.allowsMultipleSelection = false; picker.title = fields[sender.tag].placeholderString ?? "Choose"
        picker.beginSheetModal(for: panel) { [weak self] response in
            if response == .OK, let url = picker.url, let self {
                if sender.tag == 0 {
                    self.target.stringValue = ""
                    self.invalidateRoomSelection()
                }
                self.fields[sender.tag].stringValue = url.path
            }
        }
    }
    func stop() { operation.cancel() }
    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSTextField === target else { return }
        invalidateRoomSelection()
        issue.stringValue = "Connect this room before saving setup."
    }
    private func invalidateRoomSelection() {
        fields[0].stringValue = ""; connectedTarget = nil
        preview = nil; previewTarget = nil; joinButton.title = "Connect room"
    }
    @objc private func toggleAdvanced(_ sender: NSButton) { for row in advancedRows { row.isHidden = sender.state != .on }; panel.setContentSize(NSSize(width: 680, height: sender.state == .on ? 680 : 500)) }
    @objc private func cancelSetup() {
        if operation.isRunning { closing = true; operation.cancel(); issue.stringValue = "Cancelling setup…"; return }
        panel.sheetParent?.endSheet(panel); completion()
    }
    private func setBusy(_ value: Bool) {
        for button in choosingButtons + [joinButton, loginButton, saveButton] { button.isEnabled = !value }
        target.isEnabled = !value; writes.isEnabled = !value
    }
    private func run(_ input: [String: Any]) {
        guard !fields[3].stringValue.isEmpty, !fields[4].stringValue.isEmpty else {
            issue.stringValue = "Open Advanced and choose Node and the Room host script, or use a packaged app."; return
        }
        let script = URL(fileURLWithPath: fields[4].stringValue).deletingLastPathComponent().appendingPathComponent("native-agent-setup.mjs")
        guard FileManager.default.isReadableFile(atPath: script.path) else { issue.stringValue = "The selected runtime is missing its setup helper."; return }
        do {
            setBusy(true)
            try operation.start(node: URL(fileURLWithPath: fields[3].stringValue), script: script, input: input, onEvent: { [weak self] event in
                self?.receive(event)
            }, onFinish: { [weak self] success in
                guard let self else { return }; self.setBusy(false)
                if self.closing { self.panel.sheetParent?.endSheet(self.panel); self.completion(); return }
                if !success { self.issue.stringValue = "Setup could not finish. Check the link, installed runtime and network, then retry. Saved setup is retained." }
            })
        } catch { setBusy(false); issue.stringValue = "Could not start setup. Check the installed runtime in Advanced." }
    }
    @objc private func connectRoom() {
        // Every check must establish the current connection anew. Pending or
        // failed admission must never leave a previously connected room saved.
        fields[0].stringValue = ""; connectedTarget = nil
        let link = target.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !link.isEmpty else { issue.stringValue = "Paste a room or invitation link."; return }
        var input: [String: Any] = ["action": "connect", "target": link, "directory": managed.appendingPathComponent("Enrollment").path, "name": "Mac agent"]
        if previewTarget == link, let preview { input["accept"] = true; input["expectedPreview"] = preview }
        else { preview = nil; previewTarget = nil; joinButton.title = "Connect room" }
        issue.stringValue = "Checking room access…"; run(input)
    }
    @objc private func signIn() {
        guard !fields[1].stringValue.isEmpty, !fields[5].stringValue.isEmpty else { issue.stringValue = "Choose a workspace and an installed Codex executable first."; return }
        // The JS runtime creates and validates this dedicated private profile.
        let config: [String: Any] = ["command": fields[5].stringValue,
            "cwd": URL(fileURLWithPath: fields[1].stringValue).resolvingSymlinksInPath().path,
            "codexHome": fields[2].stringValue, "policy": ["approvalPolicy": "never", "sandbox": "read-only"]]
        issue.stringValue = "Checking provider sign-in…"; run(["action": "login", "config": config])
    }
    private func receive(_ event: [String: Any]) {
        guard !closing else { return }
        issue.textColor = .labelColor
        switch event["status"] as? String {
        case "approval_required":
            preview = event["expectedPreview"] as? String; previewTarget = target.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let grants = (event["permissions"] as? [String] ?? []).joined(separator: ", ")
            issue.stringValue = "Room: \(event["roomTitle"] as? String ?? event["roomId"] as? String ?? "") · Access: \(grants.isEmpty ? "chat" : grants). Choose Accept invitation to join."
            joinButton.title = "Accept invitation"
        case "connected":
            connectedTarget = target.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            fields[0].stringValue = event["configDirectory"] as? String ?? ""
            preview = nil; previewTarget = nil; joinButton.title = "Connect room"
            issue.stringValue = "Room connected: \(event["roomId"] as? String ?? ""). Choose a workspace and sign in, then save."
        case "admission_pending": issue.stringValue = "Waiting for room admission. Choose Connect room again to check; your identity is retained."
        case "choose_room": issue.stringValue = "Paste a specific room or invitation link to continue."
        case "open_browser":
            guard let text = event["authUrl"] as? String, let url = URL(string: text), url.scheme == "https",
                ["auth.openai.com", "chatgpt.com"].contains(url.host ?? ""), url.user == nil, url.password == nil, url.port == nil else {
                operation.cancel(); issue.stringValue = "Provider returned an unsupported sign-in link."; return
            }
            if NSWorkspace.shared.open(url) { issue.stringValue = "Complete sign-in in your browser. Cancel stops this attempt." }
            else { operation.cancel(); issue.stringValue = "Could not open the sign-in page. Retry after checking your default browser." }
        case "authentication_not_required": issue.stringValue = "This provider does not require sign-in. Save setup, then start the agent."
        case "credentials_present": issue.stringValue = "Provider credentials present. Save setup, then start the agent. A model task has not been verified yet."
        case "cancelled": issue.stringValue = "Sign-in cancelled."
        case "timeout": issue.stringValue = "Sign-in timed out. Try again when ready."
        default: issue.stringValue = "Setup did not finish. Check the link or provider sign-in and retry."
        }
    }
    @objc private func saveSetup() {
        if let connectedTarget, connectedTarget != target.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) {
            invalidateRoomSelection(); issue.stringValue = "Connect this room before saving setup."; return
        }
        guard fields.allSatisfy({ !$0.stringValue.isEmpty }) else { issue.stringValue = "Connect a room, choose a workspace and sign in. If tools are missing, check Advanced."; return }
        let urls = fields.map { URL(fileURLWithPath: $0.stringValue) }
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Project Room/Room Host/Setups")
        var generated: URL?
        do {
            let url = try LocalRoomHostSetup.save(.init(node: urls[3], script: urls[4], codex: urls[5], workspace: urls[1], profile: urls[2], connection: urls[0], allowWrites: writes.state == .on), directory: directory)
            generated = url; try host.configure(url)
            panel.sheetParent?.endSheet(panel); completion()
        } catch {
            if let generated { try? FileManager.default.removeItem(at: generated.deletingLastPathComponent()) }
            switch (error as? LocalToolFailure)?.code {
            case "setup_dedicated_profile_required": issue.stringValue = "Choose a dedicated Codex profile outside the workspace and your usual .codex folder."
            case "setup_private_folder_required": issue.stringValue = "The profile and room connection must be private folders owned by your Mac account."
            case "invalid_room_connection": issue.stringValue = "Choose the saved agent connection folder containing connection.json."
            default: issue.stringValue = "Setup could not be saved. Check the selected files and folders, and stop any running host."
            }
        }
    }
}
