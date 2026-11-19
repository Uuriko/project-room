import AppKit
import ProjectRoomKit

@MainActor final class Application: NSObject, NSApplicationDelegate {
    var room: RoomWindow?
    private lazy var affectedTests = LocalAffectedTests()
    let initialURL: URL
    let affectedOnly: Bool
    init(url: URL, affectedOnly: Bool) { initialURL = url; self.affectedOnly = affectedOnly }
    func applicationDidFinishLaunching(_ notification: Notification) {
        if !affectedOnly { room = RoomWindow(url: initialURL) }
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(title: "Project Room"); appItem.submenu = appMenu
        let about = appMenu.addItem(withTitle: "About Project Room", action: #selector(showAbout), keyEquivalent: "")
        about.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Project Room", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Project Room", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        let viewItem = NSMenuItem(); menu.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        for (title, selector, key) in [("Open Room", #selector(openRoom), "0"), ("Reload", #selector(RoomWindow.reload), "r"), ("Go to…", #selector(RoomWindow.goTo), "k")] {
            let item = view.addItem(withTitle: title, action: selector, keyEquivalent: key)
            item.target = title == "Open Room" ? self : room
        }
        let auth = view.addItem(withTitle: "Sign in with browser…", action: #selector(RoomWindow.signIn), keyEquivalent: "")
        auth.target = room
        let mac = view.addItem(withTitle: "My Mac…", action: #selector(RoomWindow.showMyMac), keyEquivalent: ",")
        mac.target = room
        let tests = view.addItem(withTitle: "Affected tests…", action: #selector(showAffectedTests), keyEquivalent: "")
        tests.target = self
        NSApp.mainMenu = menu
        if affectedOnly { affectedTests.show() } else { room?.show() }
    }
    func applicationWillTerminate(_ notification: Notification) { affectedTests.stop(); room?.stopLocalTools() }
    @objc func showAffectedTests() { affectedTests.show() }
    @objc func showAbout() {
        let revision = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceRevision") as? String
        let dirty = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceDirty") as? Bool ?? false
        let source = revision.map { "Source \($0.prefix(8))\(dirty ? " · local changes" : "")" } ?? "Development build"
        NSApp.orderFrontStandardAboutPanel(options: [.version: source])
    }
    @objc func openRoom() { room?.show() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if affectedOnly { affectedTests.show() } else { room?.show() }
        return true
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            // Authentication callbacks belong to ASWebAuthenticationSession.
            // Public links use the canonical HTTPS Room URL and current auth.
            if RoomLocation.allowed(url) { room?.open(url); room?.show() }
        }
    }
}

MainActor.assumeIsolated {
let args = CommandLine.arguments
let selected: URL?
if let index = args.firstIndex(of: "--url") {
    selected = index + 1 < args.count ? URL(string: args[index + 1]) : nil
} else {
    let bundledRoom = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomDefaultURL") as? String
    selected = URL(string: bundledRoom ?? "https://room.trydemigod.com")
}
guard let selected, RoomLocation.allowed(selected) else { fputs("Use an explicit HTTPS Room URL or a loopback development URL.\n", stderr); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Application(url: selected, affectedOnly: args.contains("--affected-tests"))
app.delegate = delegate
app.run()

}
