import AppKit
import ProjectRoomKit

@MainActor final class Application: NSObject, NSApplicationDelegate {
    var room: RoomWindow?
    let initialURL: URL
    init(url: URL) { initialURL = url }
    func applicationDidFinishLaunching(_ notification: Notification) {
        room = RoomWindow(url: initialURL)
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(title: "Project Room"); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Project Room", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
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
        NSApp.mainMenu = menu
        room?.show()
    }
    @objc func openRoom() { room?.show() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { room?.show(); return true }
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
let selected = args.firstIndex(of: "--url").flatMap { index in index + 1 < args.count ? URL(string: args[index + 1]) : nil } ?? URL(string: "https://room.trydemigod.com")!
guard RoomLocation.allowed(selected) else { fputs("Only the first-party Room origin or a local development server is allowed.\n", stderr); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Application(url: selected)
app.delegate = delegate
app.run()

}
