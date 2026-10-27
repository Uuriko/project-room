import AppKit
import ProjectRoomKit

@MainActor final class Application: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var room: RoomWindow?
    private var profileWindows: [UUID: RoomWindow] = [:]
    private var profileLeases: [UUID: RoomProfileLease] = [:]
    private var defaultLease: RoomProfileLease?
    private let startupProfileID: UUID?
    private let profileStore = RoomProfileStore()
    private let profilesMenu = NSMenu(title: "Profiles")
    private var activeRoom: RoomWindow? {
        profileWindows.values.first { $0.window.isKeyWindow } ?? startupProfileID.flatMap { profileWindows[$0] } ?? room
    }
    let initialURL: URL
    init(url: URL, profileID: UUID?) { initialURL = url; startupProfileID = profileID }
    func applicationDidFinishLaunching(_ notification: Notification) {
        profilesMenu.delegate = self
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
        for (title, selector, key) in [("Open Room", #selector(openRoom), "0"), ("Reload", #selector(reloadRoom), "r"), ("Go to…", #selector(goToRoom), "k")] {
            let item = view.addItem(withTitle: title, action: selector, keyEquivalent: key)
            item.target = self
        }
        let auth = view.addItem(withTitle: "Sign in with browser…", action: #selector(signInRoom), keyEquivalent: "")
        auth.target = self
        let mac = view.addItem(withTitle: "My Mac…", action: #selector(showMac), keyEquivalent: ",")
        mac.target = self
        let profilesItem = NSMenuItem()
        profilesItem.submenu = profilesMenu
        menu.addItem(profilesItem)
        rebuildProfilesMenu()
        NSApp.mainMenu = menu
        if let id = startupProfileID {
            do {
                guard let profile = try profileStore.load().first(where: { $0.id == id }) else { throw ProfileError.invalidRecord }
                openProfile(profile)
            } catch { profileError(error) }
        } else { openDefault() }
    }
    func applicationWillTerminate(_ notification: Notification) { room?.stopLocalTools() }
    @objc func showMac() {
        if room == nil { openDefault() }
        room?.showMyMac()
    }
    func menuNeedsUpdate(_ menu: NSMenu) { rebuildProfilesMenu() }
    @objc func reloadRoom() { activeRoom?.reload() }
    @objc func goToRoom() { activeRoom?.goTo() }
    @objc func signInRoom() { activeRoom?.signIn() }
    private func profileError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Couldn’t open profiles"
        if case ProfileLeaseError.inUse = error {
            alert.informativeText = "This profile is open in another Project Room instance. Use that window, quit that instance, or choose a different profile from the Profiles menu."
        } else {
        alert.informativeText = "Profile names must be 1–60 characters. If saved profiles cannot be read, repair their files before continuing; existing sign-ins have not been cleared."
        }
        alert.runModal()
    }
    private func rebuildProfilesMenu() {
        profilesMenu.removeAllItems()
        profilesMenu.addItem(withTitle: "Default", action: #selector(openDefault), keyEquivalent: "").target = self
        profilesMenu.addItem(withTitle: "New Profile…", action: #selector(newProfile), keyEquivalent: "n").target = self
        profilesMenu.addItem(.separator())
        do {
            for profile in try profileStore.load() {
                let item = profilesMenu.addItem(withTitle: profile.name, action: #selector(openProfileItem(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = profile.id.uuidString
                let separate = profilesMenu.addItem(withTitle: "Open \(profile.name) in Separate App", action: #selector(openSeparate(_:)), keyEquivalent: "")
                separate.target = self
                separate.representedObject = profile.id.uuidString
            }
        } catch { profileError(error) }
    }
    @objc func openDefault() {
        if let room { room.show(); return }
        do {
            defaultLease = try RoomProfileLease(profileID: nil)
            room = RoomWindow(url: initialURL)
            room?.show()
        } catch { profileError(error) }
    }
    @objc func openSeparate(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        if let uuid = UUID(uuidString: id), let existing = profileWindows[uuid] {
            existing.show() // Do not launch a known conflicting process.
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.createsNewApplicationInstance = true
        configuration.arguments = ["--profile", id, "--url", initialURL.absoluteString]
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { [weak self] _, error in
            if let error { Task { @MainActor in self?.profileError(error) } }
        }
    }
    @objc func openProfileItem(_ sender: NSMenuItem) {
        do {
            guard let id = sender.representedObject as? String,
                  let profile = try profileStore.load().first(where: { $0.id.uuidString == id }) else { throw ProfileError.invalidRecord }
            openProfile(profile)
        } catch { profileError(error) }
    }
    private func openProfile(_ profile: RoomProfile) {
        if let existing = profileWindows[profile.id] { existing.show(); return }
        do { profileLeases[profile.id] = try RoomProfileLease(profileID: profile.id) }
        catch { profileError(error); return }
        let window = RoomWindow(url: initialURL, profile: profile)
        window.showSharedMac = { [weak self] in self?.showMac() }
        profileWindows[profile.id] = window
        window.show()
    }
    @objc func newProfile() {
        let alert = NSAlert()
        alert.messageText = "New Profile"
        alert.informativeText = "Keep a separate sign-in for another account or agent. This name is only a label; it does not change your role or permissions. Mac tools are shared through Default."
        let name = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        name.placeholderString = "For example: Personal, Work, or Agent"
        alert.accessoryView = name
        alert.addButton(withTitle: "Create Profile")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Create in Separate App")
        alert.window.initialFirstResponder = name
        let response = alert.runModal()
        guard response == .alertFirstButtonReturn || response == .alertThirdButtonReturn else { return }
        do {
            _ = try profileStore.load() // Do not hide unreadable existing records.
            let profile = try profileStore.create(name: name.stringValue)
            rebuildProfilesMenu()
            if response == .alertThirdButtonReturn {
                let item = NSMenuItem()
                item.representedObject = profile.id.uuidString
                openSeparate(item)
            } else { openProfile(profile) }
        } catch { profileError(error) }
    }
    @objc func showAbout() {
        let revision = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceRevision") as? String
        let dirty = Bundle.main.object(forInfoDictionaryKey: "ProjectRoomSourceDirty") as? Bool ?? false
        let source = revision.map { "Source \($0.prefix(8))\(dirty ? " · local changes" : "")" } ?? "Development build"
        NSApp.orderFrontStandardAboutPanel(options: [.version: source])
    }
    @objc func openRoom() { activeRoom?.show() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { activeRoom?.show(); return true }
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            // Authentication callbacks belong to ASWebAuthenticationSession.
            // Public links use the canonical HTTPS Room URL and current auth.
            if RoomLocation.allowed(url) { activeRoom?.open(url); activeRoom?.show() }
        }
    }
}

MainActor.assumeIsolated {
let args = CommandLine.arguments
let selected = args.firstIndex(of: "--url").flatMap { index in index + 1 < args.count ? URL(string: args[index + 1]) : nil } ?? URL(string: "https://room.trydemigod.com")!
guard RoomLocation.allowed(selected) else { fputs("Only the first-party Room origin or a local development server is allowed.\n", stderr); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
var requestedProfile: UUID?
if let index = args.firstIndex(of: "--profile") {
    guard index + 1 < args.count, let id = UUID(uuidString: args[index + 1]) else {
        fputs("--profile requires a saved profile UUID.\n", stderr); exit(2)
    }
    requestedProfile = id
}
let delegate = Application(url: selected, profileID: requestedProfile)
app.delegate = delegate
app.run()

}
