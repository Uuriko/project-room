import AppKit
import ApplicationServices

public protocol LocalComputerActing {
    func perform(_ arguments: [String: Any], authorize: () throws -> Void) throws -> [String: Any]
}

// One short operation, explicitly bound to a visible window and its owner.
// Never use the clipboard or global keyboard focus as the destination of text.
public final class LocalComputerInput: LocalComputerActing {
    public init() {}
    public func perform(_ arguments: [String: Any], authorize: () throws -> Void) throws -> [String: Any] {
        func integer(_ key: String, maximum: Int64) throws -> Int64 {
            guard let n = arguments[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, n.int64Value > 0, n.int64Value <= maximum
            else { throw LocalToolFailure("invalid_tool_arguments") }
            return n.int64Value
        }
        let pid = Int32(try integer("processId", maximum: Int64(Int32.max)))
        let window = UInt32(try integer("windowId", maximum: Int64(UInt32.max)))
        guard let action = arguments["action"] as? String else { throw LocalToolFailure("invalid_tool_arguments") }
        let common: Set<String> = ["requestId", "processId", "windowId", "action"]
        let extra: [String: Set<String>] = ["activate": [], "click": ["x", "y", "button"], "type": ["text"], "key": ["key", "modifiers"], "scroll": ["x", "y", "deltaX", "deltaY"]]
        guard let keys = extra[action], Set(arguments.keys).isSubset(of: common.union(keys)) else { throw LocalToolFailure("invalid_tool_arguments") }
        guard AXIsProcessTrusted() else { throw LocalToolFailure("accessibility_permission_required") }
        func bounds() throws -> CGRect {
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            guard let entry = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window }),
                (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                let raw = entry[kCGWindowBounds as String] as? [String: Any], let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), !rect.isEmpty
            else { throw LocalToolFailure("computer_target_changed") }
            return rect
        }
        _ = try bounds()
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { throw LocalToolFailure("computer_target_changed") }
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, 0.2)
        func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        func matches(_ element: AXUIElement, _ rect: CGRect) -> Bool {
            guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
                let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return false }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(unsafeBitCast(p, to: AXValue.self), .cgPoint, &point),
                AXValueGetValue(unsafeBitCast(s, to: AXValue.self), .cgSize, &size) else { return false }
            return abs(point.x - rect.minX) < 1 && abs(point.y - rect.minY) < 1 && abs(size.width - rect.width) < 1 && abs(size.height - rect.height) < 1
        }
        func requireFocusedWindow() throws {
            let rect = try bounds()
            if pid == getpid() {
                let current = Thread.isMainThread ? NSApplication.shared.keyWindow?.windowNumber
                    : DispatchQueue.main.sync { NSApplication.shared.keyWindow?.windowNumber }
                guard app.isActive, current == Int(window) else { throw LocalToolFailure("computer_target_not_focused") }
                return
            }
            guard app.isActive, let value = attribute(ax, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID(),
                matches(unsafeBitCast(value, to: AXUIElement.self), rect) else { throw LocalToolFailure("computer_target_not_focused") }
        }
        if action == "activate" {
            if pid == getpid() {
                try authorize()
                let raise = {
                    NSApplication.shared.windows.first { $0.windowNumber == Int(window) }?.makeKeyAndOrderFront(nil)
                }
                if Thread.isMainThread { raise() } else { DispatchQueue.main.sync(execute: raise) }
                guard app.activate(options: []) else { throw LocalToolFailure("computer_activation_failed") }
                return ["state": "activation_requested", "processId": pid, "windowId": window]
            }
            let rect = try bounds()
            let windows = attribute(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []
            let matching = windows.filter { matches($0, rect) }
            guard matching.count == 1 else { throw LocalToolFailure("computer_target_ambiguous") }
            try authorize()
            // Activation is requested, not assumed completed. Reobserve before input.
            guard app.activate(options: []) else { throw LocalToolFailure("computer_activation_failed") }
            guard AXUIElementPerformAction(matching[0], kAXRaiseAction as CFString) == .success else { throw LocalToolFailure("computer_activation_unconfirmed") }
            return ["state": "activation_requested", "processId": pid, "windowId": window]
        }
        try requireFocusedWindow()
        var events: [CGEvent] = []
        func keyPair(_ code: CGKeyCode, flags: CGEventFlags = []) throws -> (CGEvent, CGEvent) {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw LocalToolFailure("computer_input_unavailable") }
            down.flags = flags; up.flags = flags
            return (down, up)
        }
        func pointerLocation() throws -> CGPoint {
            func coordinate(_ key: String) throws -> Double {
                guard let n = arguments[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                    n.doubleValue >= 0, n.doubleValue <= 1 else { throw LocalToolFailure("invalid_tool_arguments") }
                return n.doubleValue
            }
            let rect = try bounds(), x = try coordinate("x"), y = try coordinate("y")
            return CGPoint(x: rect.minX + x * (rect.width - 1), y: rect.minY + y * (rect.height - 1))
        }
        switch action {
        case "type":
            guard let text = arguments["text"] as? String, !text.isEmpty, text.utf16.count <= 4096, !text.contains("\0") else { throw LocalToolFailure("invalid_tool_arguments") }
            let (down, up) = try keyPair(0), units = Array(text.utf16)
            units.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            events = [down, up]
        case "key":
            let codes: [String: CGKeyCode] = ["return":36, "tab":48, "space":49, "backspace":51, "escape":53,
                "delete":117, "left":123, "right":124, "down":125, "up":126, "home":115, "end":119, "pageup":116, "pagedown":121,
                "a":0, "c":8, "v":9, "x":7, "z":6, "s":1, "f":3, "l":37, "r":15, "w":13, "t":17]
            guard let key = arguments["key"] as? String, let code = codes[key] else { throw LocalToolFailure("invalid_tool_arguments") }
            let modifiers = arguments["modifiers"] as? [String] ?? []
            guard arguments["modifiers"] == nil || arguments["modifiers"] is [String], modifiers.count <= 4 else { throw LocalToolFailure("invalid_tool_arguments") }
            let available: [String: CGEventFlags] = ["command":.maskCommand, "shift":.maskShift, "option":.maskAlternate, "control":.maskControl]
            var flags: CGEventFlags = []
            for modifier in modifiers { guard let flag = available[modifier] else { throw LocalToolFailure("invalid_tool_arguments") }; flags.insert(flag) }
            let (down, up) = try keyPair(code, flags: flags); events = [down, up]
        case "click":
            let point = try pointerLocation()
            let button = arguments["button"] as? String ?? "left"
            guard arguments["button"] == nil || arguments["button"] is String, ["left", "right"].contains(button) else { throw LocalToolFailure("invalid_tool_arguments") }
            let right = button == "right"
            guard let down = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseDown : .leftMouseDown, mouseCursorPosition: point, mouseButton: right ? .right : .left),
                let up = CGEvent(mouseEventSource: nil, mouseType: right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: right ? .right : .left)
            else { throw LocalToolFailure("computer_input_unavailable") }
            for event in [down, up] {
                event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
                event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window))
                event.setIntegerValueField(.mouseEventClickState, value: 1)
            }
            events = [down, up]
        case "scroll":
            func delta(_ key: String) throws -> Int32 {
                guard let n = arguments[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                    n.doubleValue.rounded() == n.doubleValue, abs(n.doubleValue) <= 2000 else { throw LocalToolFailure("invalid_tool_arguments") }
                return n.int32Value
            }
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: try delta("deltaY"), wheel2: try delta("deltaX"), wheel3: 0)
            else { throw LocalToolFailure("computer_input_unavailable") }
            event.location = try pointerLocation()
            events = [event]
        default: throw LocalToolFailure("invalid_tool_arguments")
        }
        try requireFocusedWindow()
        try authorize()
        // Keyboard events can be process-targeted. Mouse events must pass
        // through WindowServer hit testing to acquire an NSWindow destination.
        // Check the visible window at the click location immediately beforehand.
        if ["click", "scroll"].contains(action), let point = events.first?.location {
            // AX can omit a borderless panel in the same application. Refuse
            // any visible sibling window above the selected window at this point.
            let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            for entry in ordered {
                if (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window { break }
                if (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
                    let raw = entry[kCGWindowBounds as String] as? [String: Any],
                    let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.contains(point),
                    (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0 > 0 {
                    throw LocalToolFailure("computer_target_occluded")
                }
            }
            let system = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(system, 0.2)
            var hit: AXUIElement?, owner: pid_t = 0
            guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
                let hit, AXUIElementGetPid(hit, &owner) == .success, owner == pid
            else { throw LocalToolFailure("computer_target_occluded") }
            let target = attribute(hit, kAXWindowAttribute) ?? hit
            guard CFGetTypeID(target) == AXUIElementGetTypeID(),
                matches(unsafeBitCast(target, to: AXUIElement.self), try bounds())
            else { throw LocalToolFailure("computer_target_occluded") }
            try requireFocusedWindow()
            try authorize()
        }
        // Keep down/up together so Pause cannot leave a held key or mouse button.
        for event in events {
            if ["click", "scroll"].contains(action) { event.post(tap: .cgSessionEventTap) }
            else { event.postToPid(pid) }
        }
        return ["state": "input_dispatched", "processId": pid, "windowId": window, "action": action, "verifyWith": "mac_app_state"]
    }
}
