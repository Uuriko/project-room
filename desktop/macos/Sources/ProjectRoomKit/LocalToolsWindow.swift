import AppKit
import ApplicationServices
import CoreGraphics

@MainActor public final class LocalToolsWindow: NSObject {
    public let window: NSWindow
    private let service: LocalTools
    private let connection: LocalToolConnection
    private let host: LocalRoomHost
    private let hostState = NSTextField(wrappingLabelWithString: "")
    private let hostToggle = NSButton(title: "Start agent", target: nil, action: nil)
    private let hostConnect = NSButton(title: "Connect agent…", target: nil, action: nil)
    private let state = NSTextField(wrappingLabelWithString: "")
    private let permissions = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "Enable local tools", target: nil, action: nil)
    private var timer: Timer?
    private var hostIssue: String?
    public init(service: LocalTools? = nil) throws {
        let owned = try service ?? LocalTools()
        host = try LocalRoomHost()
        self.service = owned; connection = try LocalToolConnection(service: owned)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520), styleMask: [.titled,.closable], backing: .buffered, defer: false)
        super.init()
        window.title = "My Mac · Project Room"; window.isReleasedWhenClosed = false
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Let agents work on this Mac"); title.font = .systemFont(ofSize: 21, weight: .semibold)
        let explanation = NSTextField(wrappingLabelWithString: "Local tools can read and write files, run programs, and control apps as you. Enable them for this app session, then connect your agent. Pause stops new operations and running process groups.")
        let scope = NSTextField(wrappingLabelWithString: "This connects local agents. Web and shared-room device access are still being built."); scope.textColor = .secondaryLabelColor
        toggle.target = self; toggle.action = #selector(changeEnabled); toggle.bezelStyle = .rounded
        let setup = NSButton(title: "macOS permissions…", target:self, action:#selector(openPermissions)); setup.bezelStyle = .rounded
        let copy = NSButton(title:"Copy agent connection", target:self, action:#selector(copyConnection)); copy.bezelStyle = .rounded
        let controls = NSStackView(views:[toggle,setup,copy]); controls.orientation = .horizontal; controls.spacing = 8
        for view in [title,explanation,state,permissions,controls,scope] { stack.addArrangedSubview(view) }
        hostConnect.target = self; hostConnect.action = #selector(connectHost); hostConnect.bezelStyle = .rounded
        hostToggle.target = self; hostToggle.action = #selector(toggleHost); hostToggle.bezelStyle = .rounded
        let hostControls = NSStackView(views: [hostConnect, hostToggle]); hostControls.spacing = 8
        let hostNote = NSTextField(wrappingLabelWithString: "Keep Project Room open while your agent works."); hostNote.textColor = .secondaryLabelColor
        for view in [hostState, hostControls, hostNote] { stack.addArrangedSubview(view) }
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:window.contentView!.leadingAnchor,constant:24),stack.trailingAnchor.constraint(equalTo:window.contentView!.trailingAnchor,constant:-24),stack.topAnchor.constraint(equalTo:window.contentView!.topAnchor,constant:24)])
        refresh(); window.center()
        timer = Timer.scheduledTimer(withTimeInterval:1,repeats:true) { [weak self] _ in Task { @MainActor in if self?.window.isVisible == true { self?.refresh() } } }
    }
    public func show() { refresh(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps:true) }
    public func stop() { timer?.invalidate(); host.stopAndWait(); connection.stop() }
    @objc private func changeEnabled() {
        let enabled = service.status()["enabled"] as? Bool == true
        service.setEnabled(!enabled)
        do { try connection.publish() } catch { service.setEnabled(false); state.stringValue = "Connection could not update. Tools paused."; return }
        refresh()
    }
    @objc private func connectHost() {
        let picker = NSOpenPanel(); picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.title = "Choose your agent host configuration"
        picker.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = picker.url else { return }
            do { try self.host.configure(url); self.hostIssue = nil }
            catch { self.hostIssue = "Could not connect. Check the host configuration and its file paths." }
            self.refresh()
        }
    }
    @objc private func toggleHost() {
        hostIssue = nil
        if host.snapshot()["running"] as? Bool == true { host.requestStop() }
        else { do { try host.start() } catch { hostIssue = "Could not start. Check setup or another running host." } }
        refresh()
    }
    private func refresh() {
        let agent = host.snapshot(), running = agent["running"] as? Bool == true, stopping = agent["stopping"] as? Bool == true
        hostState.stringValue = hostIssue ?? (agent["message"] as? String ?? "Agent status unavailable")
        hostToggle.title = stopping ? "Stopping…" : running ? "Stop agent" : "Start agent"
        hostToggle.isEnabled = agent["configured"] as? Bool == true && !stopping
        hostConnect.isEnabled = !running

        let snapshot = service.status(), enabled = snapshot["enabled"] as? Bool == true
        state.stringValue = enabled ? "Autonomous local tools enabled · \(snapshot["runningProcesses"]!) running" : "Local tools paused"
        toggle.title = enabled ? "Pause all local tools" : "Enable local tools"
        permissions.stringValue = "App control: \(snapshot["accessibility"] as? Bool == true ? "Allowed" : "Not allowed") · Screen: \(snapshot["screenCapture"] as? Bool == true ? "Allowed" : "Not allowed")\nFull Disk Access: check macOS settings. Automation requires per-app approval."
    }
    @objc private func copyConnection() {
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ProjectRoomTools")
        if let text = try? LocalAgentConfiguration.json(executable: executable, connection: connection.connectionURL) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text,forType:.string) }
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
