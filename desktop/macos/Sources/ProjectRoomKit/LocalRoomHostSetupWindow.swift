import AppKit

@MainActor final class LocalRoomHostSetupWindow: NSObject {
    private let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 720, height: 540), styleMask: [.titled], backing: .buffered, defer: false)
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
        let note = NSTextField(wrappingLabelWithString: "Choose your saved room connection, workspace, and dedicated signed-in Codex profile. Project Room saves the configuration for you. This setup currently requires an enrolled agent and an installed Node/Codex runtime.")
        stack.addArrangedSubview(note)
        let labels = ["Room connection folder", "Workspace", "Dedicated Codex profile", "Node executable", "Room host script", "Codex executable"]
        for (index, label) in labels.enumerated() {
            let field = NSTextField(); field.placeholderString = label; field.isEditable = false
            field.setAccessibilityLabel(label); field.lineBreakMode = .byTruncatingMiddle
            let button = NSButton(title: "Choose…", target: self, action: #selector(choose(_:))); button.tag = index; button.bezelStyle = .rounded
            let caption = NSTextField(labelWithString: label); caption.font = .systemFont(ofSize: 12)
            caption.widthAnchor.constraint(equalToConstant: 155).isActive = true
            let row = NSStackView(views: [caption, field, button]); row.spacing = 8
            stack.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
            fields.append(field)
        }
        let fm = FileManager.default
        fields[3].stringValue = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: fm.isExecutableFile(atPath:)) ?? ""
        fields[5].stringValue = ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"].first(where: fm.isExecutableFile(atPath:)) ?? ""
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("room-runtime/scripts/run-codex-room.mjs"), fm.isReadableFile(atPath: bundled.path) { fields[4].stringValue = bundled.path }
        stack.addArrangedSubview(writes)
        let permissions = NSTextField(wrappingLabelWithString: "Computer control is separate. After saving, use Connect Mac tools to choose observation or app control. Saving does not start an agent.")
        permissions.textColor = .secondaryLabelColor; stack.addArrangedSubview(permissions)
        issue.textColor = .systemRed; stack.addArrangedSubview(issue)
        let save = NSButton(title: "Save setup", target: self, action: #selector(saveSetup)); save.bezelStyle = .rounded
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelSetup)); cancel.bezelStyle = .rounded; cancel.keyEquivalent = "\u{1b}"
        stack.addArrangedSubview(NSStackView(views: [cancel, save]))
        panel.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 24)])
    }
    func show(on parent: NSWindow) { parent.beginSheet(panel) }
    @objc private func choose(_ sender: NSButton) {
        let picker = NSOpenPanel(); picker.canChooseDirectories = sender.tag < 3; picker.canChooseFiles = sender.tag >= 3
        picker.allowsMultipleSelection = false; picker.title = fields[sender.tag].placeholderString ?? "Choose"
        picker.beginSheetModal(for: panel) { [weak self] response in
            if response == .OK, let url = picker.url { self?.fields[sender.tag].stringValue = url.path }
        }
    }
    @objc private func cancelSetup() { panel.sheetParent?.endSheet(panel); completion() }
    @objc private func saveSetup() {
        guard fields.allSatisfy({ !$0.stringValue.isEmpty }) else { issue.stringValue = "Choose all six locations before saving."; return }
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
