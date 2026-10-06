import AppKit
import ApplicationServices
import CoreGraphics

@MainActor public final class LocalToolsWindow: NSObject {
    public let window: NSWindow
    private let service: LocalTools
    private let connection: LocalToolConnection
    private let state = NSTextField(wrappingLabelWithString: "")
    private let permissions = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "Enable local tools", target: nil, action: nil)
    private var timer: Timer?
    public init(service: LocalTools? = nil) throws {
        let owned = try service ?? LocalTools()
        self.service = owned; connection = try LocalToolConnection(service: owned)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 380), styleMask: [.titled,.closable], backing: .buffered, defer: false)
        super.init()
        window.title = "My Mac · Project Room"; window.isReleasedWhenClosed = false
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Let agents work on this Mac"); title.font = .systemFont(ofSize: 21, weight: .semibold)
        let explanation = NSTextField(wrappingLabelWithString: "Local tools can read and write files and run programs as you. Enable them for this app session, then connect your agent. Pause stops new operations and running process groups.")
        let scope = NSTextField(wrappingLabelWithString: "This connects local agents. Web and shared-room device access are still being built."); scope.textColor = .secondaryLabelColor
        toggle.target = self; toggle.action = #selector(changeEnabled); toggle.bezelStyle = .rounded
        let setup = NSButton(title: "macOS permissions…", target:self, action:#selector(openPermissions)); setup.bezelStyle = .rounded
        let copy = NSButton(title:"Copy agent connection", target:self, action:#selector(copyConnection)); copy.bezelStyle = .rounded
        let controls = NSStackView(views:[toggle,setup,copy]); controls.orientation = .horizontal; controls.spacing = 8
        for view in [title,explanation,state,permissions,controls,scope] { stack.addArrangedSubview(view) }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:24),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-24),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:24)])
        refresh(); window.center()
        timer = Timer.scheduledTimer(withTimeInterval:1,repeats:true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
    }
    public func show() { refresh(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true) }
    public func stop() { timer?.invalidate(); connection.stop() }
    @objc private func changeEnabled() {
        let enabled = service.status()["enabled"] as? Bool == true
        service.setEnabled(!enabled)
        do { try connection.publish() } catch { service.setEnabled(false); state.stringValue = "Connection could not update. Tools paused."; return }
        refresh()
    }
    private func refresh() {
        let snapshot = service.status(), enabled = snapshot["enabled"] as? Bool == true
        state.stringValue = enabled ? "Autonomous local tools enabled · \(snapshot["runningProcesses"]!) running" : "Local tools paused"
        toggle.title = enabled ? "Pause all local tools" : "Enable local tools"
        permissions.stringValue = "App control: \(snapshot["accessibility"] as? Bool == true ? "Allowed" : "Not allowed") · Screen: \(snapshot["screenCapture"] as? Bool == true ? "Allowed" : "Not allowed")\nFull Disk Access: check macOS settings. Automation requires per-app approval."
    }
    @objc private func copyConnection() {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ProjectRoomTools").path
        let config: [String:Any] = ["mcpServers":["project-room-mac":["command":executable,"args":[]]]]
        if let data = try? JSONSerialization.data(withJSONObject:config,options:[.prettyPrinted,.sortedKeys]), let text = String(data:data,encoding:.utf8) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text,forType:.string) }
    }
    @objc private func openPermissions() {
        let alert = NSAlert(); alert.messageText = "Choose what Project Room can access"
        alert.informativeText = "In System Settings → Privacy & Security, enable Accessibility, Screen & System Audio Recording, and Full Disk Access for Project Room as desired. Automation permissions are requested per app. Local file and process tools work within the permissions macOS actually grants."
        alert.addButton(withTitle:"Open System Settings"); alert.addButton(withTitle:"Request app control"); alert.addButton(withTitle:"Request screen access"); alert.addButton(withTitle:"Cancel")
        alert.beginSheetModal(for:window) { response in
            if response == .alertFirstButtonReturn, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier:"com.apple.systempreferences") { NSWorkspace.shared.open(url) }
            else if response == .alertSecondButtonReturn { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary) }
            else if response == .alertThirdButtonReturn { _ = CGRequestScreenCaptureAccess() }
        }
    }
}
