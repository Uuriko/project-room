import AppKit
import ProjectRoomKit

@MainActor final class Application: NSObject, NSApplicationDelegate {
    var room: RoomWindow?
    let initialURL: URL
    let selfHostedOrigin: URL?
    init(url: URL, selfHostedOrigin: URL?) { initialURL = url; self.selfHostedOrigin = selfHostedOrigin }
    func applicationDidFinishLaunching(_ notification: Notification) {
        room = RoomWindow(url: initialURL, selfHostedOrigin: selfHostedOrigin)
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
        NSApp.mainMenu = menu
        room?.show()
    }
    func applicationWillTerminate(_ notification: Notification) { room?.stopLocalTools() }
    @objc func showAbout() {
        let revision = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceRevision") as? String
        let dirty = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceDirty") as? Bool ?? false
        let source = revision.map { "Source \($0.prefix(8))\(dirty ? " · local changes" : "")" } ?? "Development build"
        NSApp.orderFrontStandardAboutPanel(options: [.version: source])
    }
    @objc func openRoom() { room?.show() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { room?.show(); return true }
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            // Authentication callbacks belong to ASWebAuthenticationSession.
            // Incoming links may navigate only within the already selected origin.
            if let room, RoomLocation.sameOrigin(url, room.origin) { room.open(url); room.show() }
        }
    }
}

MainActor.assumeIsolated {
let args = CommandLine.arguments
func argument(_ name: String) -> String? {
    let matches = args.indices.filter { args[$0] == name }
    guard matches.count <= 1 else { fputs("Duplicate Room argument.\n", stderr); exit(2) }
    guard let index = matches.first else { return nil }
    guard index + 1 < args.count, !args[index + 1].hasPrefix("--") else {
        fputs("Missing Room argument value.\n", stderr); exit(2)
    }
    return args[index + 1]
}
let originArgument = argument("--self-hosted-origin")
let selfHostedOrigin = originArgument.flatMap { URL(string: $0) }
if originArgument != nil && (selfHostedOrigin == nil || !RoomLocation.validSelfHostedOrigin(selfHostedOrigin!)) {
    fputs("Self-hosted origin must be an HTTPS root origin without credentials, query, or fragment.\n", stderr); exit(2)
}
let destination = argument("--url") ?? originArgument ?? "https://room.trydemigod.com"
guard let selected = URL(string: destination), RoomLocation.allowed(selected, selfHostedOrigin: selfHostedOrigin) else {
    fputs("Destination must match the explicitly selected origin, or use the default hosted/local development policy.\n", stderr); exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = Application(url: selected, selfHostedOrigin: selfHostedOrigin)
app.delegate = delegate
app.run()

}
