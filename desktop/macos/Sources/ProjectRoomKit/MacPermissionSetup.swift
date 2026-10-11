import AppKit
import ApplicationServices
import CoreGraphics

// Permission observations remain separate from the owner's local-tools grant.
// Moving between steps never requests access or enables execution.
@MainActor final class MacPermissionSetup: NSObject {
    private let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 310), styleMask: [.titled], backing: .buffered, defer: false)
    private let progress = NSTextField(labelWithString: "")
    private let heading = NSTextField(wrappingLabelWithString: "")
    private let detail = NSTextField(wrappingLabelWithString: "")
    private let status = NSTextField(wrappingLabelWithString: "")
    private let action = NSButton(title: "", target: nil, action: nil)
    private let back = NSButton(title: "Back", target: nil, action: nil)
    private let next = NSButton(title: "Next", target: nil, action: nil)
    private var step = 0
    private var timer: Timer?
    private var previousStatus = ""

    override init() {
        super.init()
        sheet.title = "Mac access"
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading
        stack.spacing = 14; stack.translatesAutoresizingMaskIntoConstraints = false
        progress.textColor = .secondaryLabelColor
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        status.textColor = .secondaryLabelColor
        action.target = self; action.action = #selector(requestAccess); action.bezelStyle = .rounded
        back.target = self; back.action = #selector(goBack); back.bezelStyle = .rounded
        next.target = self; next.action = #selector(goNext); next.bezelStyle = .rounded; next.keyEquivalent = "\r"
        let close = NSButton(title: "Done for now", target: self, action: #selector(closeSetup))
        close.bezelStyle = .rounded; close.keyEquivalent = "\u{1b}"
        let nav = NSStackView(views: [back, next, close]); nav.spacing = 8
        for view in [progress, heading, detail, status, action, nav] { stack.addArrangedSubview(view) }
        sheet.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: sheet.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: sheet.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: sheet.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: sheet.contentView!.bottomAnchor, constant: -24),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            detail.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
    }
    func show(on parent: NSWindow) {
        guard sheet.sheetParent == nil else { return }
        render()
        parent.beginSheet(sheet) { [weak self] _ in self?.timer?.invalidate(); self?.timer = nil }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
    }
    private func render() {
        let titles = ["Control apps", "See the screen", "Access protected files", "Connect your agent"]
        let descriptions = [
            "Allow Accessibility for Project Room to support app control. macOS manages this permission.",
            "Allow screen recording for visual computer tools. You can continue without it.",
            "For work with protected folders, add Project Room to Full Disk Access in Privacy & Security. Automation access is granted separately for each app.",
            "Return to My Mac, enable local tools, and copy the agent connection into your agent's MCP settings. This connects a local agent; shared-room device access is not available yet."
        ]
        progress.stringValue = "\(step + 1) of 4"
        heading.stringValue = titles[step]; detail.stringValue = descriptions[step]
        back.isEnabled = step > 0; next.title = step == 3 ? "Finish" : "Next"
        action.isHidden = step == 3
        action.title = step == 0 ? "Allow app control" : step == 1 ? "Allow screen access" : "Open System Settings"
        previousStatus = ""; refreshStatus()
        sheet.makeFirstResponder(next)
    }
    private func refreshStatus() {
        let text: String
        switch step {
        case 0:
            let granted = AXIsProcessTrusted(); action.isEnabled = !granted
            text = granted ? "Allowed by macOS" : "Not allowed yet. You can skip this step."
        case 1:
            let granted = CGPreflightScreenCaptureAccess(); action.isEnabled = !granted
            text = granted ? "Allowed by macOS" : "Not allowed yet. macOS may ask you to reopen the app."
        case 2:
            action.isEnabled = true
            text = "Check the switch in System Settings. Project Room cannot verify this permission here."
        default:
            text = "Setup does not enable tools or grant access to other room members."
        }
        if text != previousStatus {
            previousStatus = text; status.stringValue = text
            NSAccessibility.post(element: status, notification: .valueChanged)
        }
    }
    @objc private func requestAccess() {
        if step == 0 { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
        else if step == 1 { _ = CGRequestScreenCaptureAccess() }
        else if step == 2, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") { NSWorkspace.shared.open(url) }
        refreshStatus()
    }
    @objc private func goBack() { if step > 0 { step -= 1; render() } }
    @objc private func goNext() { if step < 3 { step += 1; render() } else { closeSetup() } }
    @objc private func closeSetup() { timer?.invalidate(); timer = nil; sheet.sheetParent?.endSheet(sheet) }
}
