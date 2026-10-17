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
    private let macConnect = NSButton(title: "Connect Mac tools…", target: nil, action: nil)
    private let hostConnect = NSButton(title: "Set up agent…", target: nil, action: nil)
    private let state = NSTextField(wrappingLabelWithString: "")
    private let permissions = NSTextField(wrappingLabelWithString: "")
    private let toggle = NSButton(title: "Enable local tools", target: nil, action: nil)
    private var timer: Timer?
    private var hostIssue: String?
    private var setupWindow: LocalRoomHostSetupWindow?
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
        let scope = NSTextField(wrappingLabelWithString: "A connected room agent can use this Mac while Project Room is open. Only enable access for a room you trust."); scope.textColor = .secondaryLabelColor
        toggle.target = self; toggle.action = #selector(changeEnabled); toggle.bezelStyle = .rounded
        let setup = NSButton(title: "macOS permissions…", target:self, action:#selector(openPermissions)); setup.bezelStyle = .rounded
        let copy = NSButton(title:"Copy agent connection", target:self, action:#selector(copyConnection)); copy.bezelStyle = .rounded
        let controls = NSStackView(views:[toggle,setup,copy]); controls.orientation = .horizontal; controls.spacing = 8
        for view in [title,explanation,state,permissions,controls,scope] { stack.addArrangedSubview(view) }
        hostConnect.target = self; hostConnect.action = #selector(setupHost); hostConnect.bezelStyle = .rounded
        hostToggle.target = self; hostToggle.action = #selector(toggleHost); hostToggle.bezelStyle = .rounded
        macConnect.target = self; macConnect.action = #selector(connectMacTools); macConnect.bezelStyle = .rounded
        let hostControls = NSStackView(views: [hostConnect, macConnect, hostToggle]); hostControls.spacing = 8
        let hostNote = NSTextField(wrappingLabelWithString: "Keep Project Room open while your agent works."); hostNote.textColor = .secondaryLabelColor
        let importHost = NSButton(title: "Import existing host configuration…", target: self, action: #selector(connectHost)); importHost.bezelStyle = .rounded
        for view in [hostState, hostControls, hostNote, importHost] { stack.addArrangedSubview(view) }
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
    @objc private func setupHost() {
        setupWindow = LocalRoomHostSetupWindow(host: host) { [weak self] in
            self?.setupWindow = nil; self?.hostIssue = nil; self?.refresh()
        }
        setupWindow?.show(on: window)
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
    @objc private func connectMacTools() {
        let selected = host.snapshot()
        let alert = NSAlert(); alert.messageText = "Connect this Mac to your room agent"
        alert.informativeText = "Room: \(selected["roomId"] as? String ?? "")\n\(selected["origin"] as? String ?? "")\n\nObservation lets the agent read app state and screenshots. App control also lets it type, click and scroll as you. Local tools must be enabled and macOS permissions granted. Other room members may contribute requests to this agent."
        alert.addButton(withTitle: "Observation only"); alert.addButton(withTitle: "Allow app control"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn || response == .alertSecondButtonReturn else { return }
            let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ProjectRoomTools")
            do {
                try self.host.connectMacTools(executable: executable, connection: self.connection.connectionURL,
                    allowInput: response == .alertSecondButtonReturn)
                self.hostIssue = "Mac tools connected. Enable local tools, then start the agent."
            } catch { self.hostIssue = "Could not connect Mac tools. Stop the agent and check its setup, then try again." }
            self.refresh()
        }
    }
    @objc private func toggleHost() {
        hostIssue = nil
        if host.snapshot()["running"] as? Bool == true { host.requestStop() }
        else { do { try host.start() } catch { hostIssue = (error as? LocalToolFailure)?.code == "room_connection_changed"
            ? "The room connection changed. Choose Set up agent to review its setup before starting."
            : "Could not start. Check setup or another running host." } }
        refresh()
    }
    private func refresh() {
        let agent = host.snapshot(), running = agent["running"] as? Bool == true, stopping = agent["stopping"] as? Bool == true
        hostState.stringValue = hostIssue ?? (agent["message"] as? String ?? "Agent status unavailable")
        hostToggle.title = stopping ? "Stopping…" : running ? "Stop agent" : "Start agent"
        hostToggle.isEnabled = agent["configured"] as? Bool == true && !stopping
        hostConnect.isEnabled = !running
        macConnect.isEnabled = agent["configured"] as? Bool == true && !running && !stopping

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
