import AppKit

/// One status item, backed by the same local tool service as the My Mac window.
@MainActor public final class RoomMenuBar: NSObject, NSMenuDelegate {
    public let item: NSStatusItem
    private let status: () -> [String: Any]
    private let openRoom: () -> Void
    private let openMac: () -> Void
    private let permissions: () -> Void
    private let pause: () -> Void
    private let statusRow = NSMenuItem(title: "Local tools paused", action: nil, keyEquivalent: "")
    private let pauseRow = NSMenuItem(title: "Pause local tools", action: nil, keyEquivalent: "")

    public init(status: @escaping () -> [String: Any], openRoom: @escaping () -> Void,
                openMac: @escaping () -> Void, permissions: @escaping () -> Void,
                pause: @escaping () -> Void) {
        self.status = status; self.openRoom = openRoom; self.openMac = openMac
        self.permissions = permissions; self.pause = pause
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        super.init()
        item.button?.image = Self.cubeImage()
        item.button?.setAccessibilityLabel("Project Room")
        item.button?.toolTip = "Project Room"
        let menu = NSMenu(); menu.autoenablesItems = false; menu.delegate = self
        func add(_ title: String, _ action: Selector) {
            let row = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
            row.target = self
        }
        add("Open Project Room", #selector(showRoom))
        menu.addItem(.separator())
        statusRow.isEnabled = false; menu.addItem(statusRow)
        pauseRow.target = self; pauseRow.action = #selector(pauseTools); menu.addItem(pauseRow)
        add("My Mac…", #selector(showMac))
        add("Permissions…", #selector(showPermissions))
        menu.addItem(.separator())
        add("Quit Project Room", #selector(quit))
        item.menu = menu
        refresh()
    }
    public func menuWillOpen(_ menu: NSMenu) { refresh() }
    public func refresh() {
        let snapshot = status(), enabled = snapshot["enabled"] as? Bool == true
        let count = snapshot["runningProcesses"] as? Int ?? 0
        statusRow.title = enabled ? "Local tools enabled · \(count) running" : "Local tools paused"
        pauseRow.isEnabled = enabled
    }
    @objc private func showRoom() { openRoom() }
    @objc private func showMac() { openMac() }
    @objc private func showPermissions() { permissions() }
    @objc private func pauseTools() { pause(); refresh() }
    @objc private func quit() { NSApp.terminate(nil) }

    // The existing Project Room cube, redrawn without its tile for crisp menu-bar sizing.
    public static func cubeImage() -> NSImage {
        NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let green = NSColor(srgbRed: 61/255, green: 1, blue: 139/255, alpha: 1)
            let top = NSPoint(x: 9, y: 17), left = NSPoint(x: 2, y: 13)
            let right = NSPoint(x: 16, y: 13), center = NSPoint(x: 9, y: 9)
            let bottom = NSPoint(x: 9, y: 1), lowerLeft = NSPoint(x: 2, y: 5), lowerRight = NSPoint(x: 16, y: 5)
            for (points, alpha) in [([top, left, center, right], 0.55), ([left, lowerLeft, bottom, center], 0.28), ([center, bottom, lowerRight, right], 0.12)] {
                let face = NSBezierPath(); face.move(to: points[0]); points.dropFirst().forEach { face.line(to: $0) }; face.close()
                green.withAlphaComponent(alpha).setFill(); face.fill()
            }
            let edge = NSBezierPath(); edge.move(to: top)
            [left, lowerLeft, bottom, lowerRight, right, top].forEach { edge.line(to: $0) }
            edge.move(to: left); edge.line(to: center); edge.line(to: right)
            edge.move(to: center); edge.line(to: bottom)
            edge.lineWidth = 1.5; edge.lineJoinStyle = .round; edge.lineCapStyle = .round
            green.setStroke(); edge.stroke(); return true
        }
    }
}
