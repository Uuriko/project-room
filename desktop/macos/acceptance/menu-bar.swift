import AppKit

@main struct MenuBarAcceptance {
    @MainActor static func main() {
        _ = NSApplication.shared
        var enabled = true, opened = 0, mac = 0, permissions = 0, paused = 0
        let bar = RoomMenuBar(status: { ["enabled": enabled, "runningProcesses": 2] },
            openRoom: { opened += 1 }, openMac: { mac += 1 }, permissions: { permissions += 1 },
            pause: { enabled = false; paused += 1 })
        let menu = bar.item.menu!
        precondition(bar.item.button?.image?.size == NSSize(width:18,height:18))
        precondition(menu.items[2].title == "Local tools enabled · 2 running")
        func click(_ title: String) {
            let row = menu.items.first { $0.title == title }!
            precondition(row.isEnabled)
            NSApp.sendAction(row.action!, to: row.target, from: row)
        }
        click("Open Project Room"); click("My Mac…"); click("Permissions…"); click("Pause local tools")
        precondition(opened == 1 && mac == 1 && permissions == 1 && paused == 1)
        precondition(menu.items[2].title == "Local tools paused" && !menu.items[3].isEnabled)
        enabled = true; bar.menuWillOpen(menu)
        precondition(menu.items[3].isEnabled)
        NSStatusBar.system.removeStatusItem(bar.item)
        print("PASS: cube, real status refresh, all navigation callbacks, pause and disabled state")
    }
}
