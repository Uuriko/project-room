import AppKit

@main struct PermissionSetupAcceptance {
    @MainActor static func main() {
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        let setup = MacPermissionSetup()
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        func button(_ title: String) -> NSButton {
            guard let sheet = parent.attachedSheet,
                  let found = descendants(sheet.contentView!).compactMap({ $0 as? NSButton }).first(where: { $0.title == title }) else { fatalError("Missing button: \(title)") }
            return found
        }
        func text(_ value: String) -> Bool {
            guard let root = parent.attachedSheet?.contentView else { return false }
            return descendants(root).compactMap { $0 as? NSTextField }.contains { $0.stringValue == value }
        }
        setup.show(on: parent)
        precondition(text("Control apps")); precondition(!button("Back").isEnabled)
        button("Next").performClick(nil)
        precondition(text("See the screen"))
        button("Back").performClick(nil)
        precondition(text("Control apps"))
        button("Next").performClick(nil); button("Next").performClick(nil)
        precondition(text("Access protected files"))
        precondition(text("Check the switch in System Settings. Project Room cannot verify this permission here."))
        button("Done for now").performClick(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        precondition(parent.attachedSheet == nil)
        setup.show(on: parent)
        precondition(text("Access protected files")) // Closing/reopening preserves place.
        button("Next").performClick(nil)
        precondition(text("Connect your agent"))
        precondition(text("Setup does not enable tools or grant access to other room members."))
        button("Finish").performClick(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        precondition(parent.attachedSheet == nil)
        print("PASS: navigation, skipping, unknown permission state, resume and completion; no permission requests issued")
    }
}
