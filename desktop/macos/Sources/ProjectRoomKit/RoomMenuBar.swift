import AppKit
import SwiftUI
import ServiceManagement

@MainActor final class RoomMenuModel: ObservableObject {
    @Published var draft = ""
    @Published var focusToken = 0
    @Published var destination = "Open a room"
    @Published var context = ""
    @Published var ready = false
    @Published var enabled = false
    @Published var tasks: [String] = []
    @Published var runs: [[String:String]] = []
    @Published var taskNames: [String: String] = [:]
    @Published var attention: Int?
    @Published var error = ""
    @Published var submitting = false
    @Published var shortcut = UserDefaults.standard.integer(forKey:"menuShortcut")
    @Published var login = SMAppService.mainApp.status == .enabled
}

@MainActor public final class RoomMenuBar: NSObject {
    public let item = NSStatusBar.system.statusItem(withLength:NSStatusItem.squareLength)
    let popover = NSPopover()
    let model = RoomMenuModel()
    private weak var room: RoomWindow?
    private var timer: Timer?
    private var refreshPending = false
    private var lastRefresh = Date.distantPast
    private var hotKey: RoomMenuShortcut?

    public init(room: RoomWindow) {
        self.room = room
        super.init()
        model.enabled = room.localToolStatus["enabled"] as? Bool == true
        item.button?.image = Self.cubeImage()
        item.button?.setAccessibilityLabel("Project Room")
        item.button?.toolTip = "Project Room"
        item.button?.target = self; item.button?.action = #selector(toggle)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: RoomMenuPanel(model:model, owner:self))
        configureShortcut(model.shortcut)
        timer = Timer.scheduledTimer(withTimeInterval:1,repeats:true) { [weak self] _ in Task { @MainActor in guard let self, Date().timeIntervalSince(self.lastRefresh) >= (self.popover.isShown ? 2 : 15) else { return }; await self.refresh() } }
    }
    @objc public func toggle() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = item.button else { return }
        NSApp.activate(ignoringOtherApps:true)
        popover.show(relativeTo:button.bounds, of:button, preferredEdge:.minY)
        popover.contentViewController?.view.window?.makeKey()
        model.focusToken += 1
        Task { await refresh() }
    }
    func close() { popover.performClose(nil) }
    func openRoom() { close(); room?.show() }
    func openMac() { close(); room?.showMyMac() }
    func attention() { close(); room?.menuAttention() }
    func pause() {
        if model.enabled { room?.pauseLocalTools() }
        else {
            do { try room?.resumeLocalTools(); model.error = "" }
            catch { model.error = "Couldn’t resume tools. Open My Mac." }
        }
        Task { await refresh() }
    }
    func stop(_ id: String) {
        do { try room?.cancelLocalTask(id) } catch { model.error = "Couldn’t stop this task. Open My Mac." }
        Task { await refresh() }
    }
    func stopRun(_ run: [String:String]) {
        let context = model.context
        Task {
            do {
                if try await room?.menuStopRun(run["id"] ?? "", revision:run["revision"] ?? "", context:context) == true { openRoom() }
                else { model.error = "Task changed. Open the room to review it." }
            } catch { model.error = "Couldn’t stop the room task. Open the room." }
            await refresh()
        }
    }
    func send() {
        let text = model.draft.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !text.isEmpty, !model.submitting else { return }
        guard model.ready else { model.error = "Open a room and sign in first."; return }
        model.submitting = true; model.error = ""
        let context = model.context
        Task {
            defer { model.submitting = false }
            do {
                guard let room else { return }
                let problem = try await room.menuPrompt(text, context:context)
                if problem.isEmpty { model.draft = ""; openRoom() }
                else { model.error = problem; await refresh() }
            } catch { model.error = "Couldn’t reach the room. Your text is saved here." }
        }
    }
    func refresh() async {
        guard !refreshPending else { return }; refreshPending = true
        defer { refreshPending = false; lastRefresh = Date() }
        let status = room?.localToolStatus ?? [:]
        model.enabled = status["enabled"] as? Bool == true
        model.tasks = status["activeRequests"] as? [String] ?? []
        model.taskNames = status["activeTaskNames"] as? [String:String] ?? [:]
        do {
            let snapshot = try await room?.menuSnapshot() ?? [:]
            model.destination = snapshot["destination"] as? String ?? "Open a room"
            model.context = snapshot["context"] as? String ?? ""
            model.ready = snapshot["ready"] as? Bool == true
            model.runs = snapshot["runs"] as? [[String:String]] ?? []
            model.attention = (snapshot["attentionError"] as? String ?? "").isEmpty ? snapshot["attention"] as? Int : nil
        } catch { model.ready = false; model.attention = nil; model.runs = [] }
        let dot = (model.attention ?? 0) > 0
        item.button?.image = Self.badgedCube(dot)
        item.button?.toolTip = dot ? "Project Room · Needs you" : "Project Room"
    }
    func configureShortcut(_ choice: Int) {
        hotKey = nil
        model.shortcut = choice
        UserDefaults.standard.set(choice,forKey:"menuShortcut")
        guard choice != 2 else { return }
        hotKey = RoomMenuShortcut(alternate:choice == 1) { [weak self] in self?.toggle() }
        if hotKey?.registered != true { model.error = "Shortcut unavailable. Choose another in settings." }
    }
    func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
            model.login = SMAppService.mainApp.status == .enabled
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch { model.error = "Couldn’t update launch at login. Check System Settings." }
    }
    static func badgedCube(_ attention: Bool) -> NSImage {
        guard attention else { return cubeImage() }
        let cube = cubeImage()
        return NSImage(size:NSSize(width:18,height:18),flipped:false) { _ in
            cube.draw(in:NSRect(x:0,y:0,width:18,height:18))
            NSColor.labelColor.setFill(); NSBezierPath(ovalIn:NSRect(x:13,y:13,width:5,height:5)).fill(); return true
        }
    }
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

@MainActor struct RoomMenuPanel: View {
    @ObservedObject var model: RoomMenuModel
    let owner: RoomMenuBar
    @FocusState private var focused: Bool
    @State private var expanded = false
    var body: some View {
        VStack(alignment:.leading, spacing:14) {
            HStack {
                Text("PROJECT ROOM").font(.system(size:11,weight:.semibold,design:.monospaced)).foregroundStyle(.secondary)
                Spacer()
                Button("Open", systemImage:"arrow.up.right", action:owner.openRoom).buttonStyle(.plain)
            }
            HStack {
                Circle().fill(model.enabled ? Color.green : Color.secondary).frame(width:6,height:6)
                Text(model.enabled ? (model.tasks.isEmpty ? "Ready" : "Working") : "Paused")
                Text("on this Mac").foregroundStyle(.secondary)
                Spacer()
                Button(model.enabled ? "Pause" : "Resume", action:owner.pause).help(model.enabled ? "Stop this Mac’s local tools and running processes" : "Enable this Mac’s local tools")
            }.font(.system(size:12))
            TextField("Ask Room…", text:$model.draft).textFieldStyle(.roundedBorder)
                .focused($focused).onSubmit(owner.send).disabled(model.submitting)
                .accessibilityLabel("Ask Room")
            Text(model.destination.isEmpty ? "Open a room" : model.destination).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            if !model.error.isEmpty { Text(model.error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true) }
            Divider()
            Button(action:owner.attention) {
                HStack { Text("Needs you"); Spacer(); Text(model.attention.map(String.init) ?? "—").foregroundStyle(.secondary); Image(systemName:"chevron.right").font(.caption2) }
            }.buttonStyle(.plain)
            DisclosureGroup(isExpanded:$expanded) {
                ScrollView {
                    VStack(alignment:.leading,spacing:10) {
                        if model.tasks.isEmpty && model.runs.isEmpty { Text("No active tasks").font(.caption).foregroundStyle(.secondary) }
                        ForEach(model.tasks, id:\.self) { id in
                            HStack { Text(model.taskNames[id] ?? "Local task").help(id).font(.caption).lineLimit(1); Spacer(); Button("Stop") { owner.stop(id) } }.help("On this Mac")
                        }
                        ForEach(model.runs.indices, id:\.self) { index in
                            let run = model.runs[index]
                            HStack {
                                VStack(alignment:.leading) { Text(run["title"] ?? "Room task").lineLimit(2); Text(run["status"] ?? "").foregroundStyle(.secondary) }.font(.caption)
                                Spacer(); Button("Stop") { owner.stopRun(run) }
                            }
                        }
                    }.padding(.top,6)
                }.frame(height: min(CGFloat(max(1,model.tasks.count + model.runs.count)) * 48, 180))
            } label: { HStack { Text("Tasks"); Spacer(); Text(String(model.tasks.count + model.runs.count)).foregroundStyle(.secondary) } }
            Divider()
            HStack {
                Button("My Mac",action:owner.openMac).buttonStyle(.plain)
                Spacer()
                Menu {
                    Picker("Shortcut",selection:Binding(get:{model.shortcut},set:owner.configureShortcut)) {
                        Text("⌃⌥Space").tag(0); Text("⌃⇧Space").tag(1); Text("Off").tag(2)
                    }
                    Button(model.login ? "Disable launch at login" : "Launch at login",action:owner.toggleLogin)
                    Divider()
                    Button("Quit Project Room") { NSApp.terminate(nil) }
                } label: { Image(systemName:"gearshape") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Settings")
            }
        }.padding(18).frame(width:340).background(Color(nsColor:.windowBackgroundColor))
            .onAppear { focused = true }.onChange(of:model.focusToken) { focused = true }.onExitCommand(perform:owner.close)
    }
}
