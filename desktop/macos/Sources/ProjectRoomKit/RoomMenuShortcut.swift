import AppKit
import Carbon

/// Carbon hot keys need no Accessibility or input-monitoring permission.
@MainActor final class RoomMenuShortcut {
    private var reference: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var localMonitor: Any?
    let action: () -> Void
    var registered: Bool { reference != nil }
    init(alternate: Bool, action: @escaping () -> Void) {
        self.action = action
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, context in
            guard let context else { return OSStatus(eventNotHandledErr) }
            MainActor.assumeIsolated { Unmanaged<RoomMenuShortcut>.fromOpaque(context).takeUnretainedValue().action() }
            return noErr
        }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
        // App-targeted events (including accessibility keyboard input) may not
        // travel through the system hot-key dispatcher.
        localMonitor = NSEvent.addLocalMonitorForEvents(matching:.keyDown) { [weak self] event in
            let wanted: NSEvent.ModifierFlags = alternate ? [.control,.shift] : [.control,.option]
            let actual = event.modifierFlags.intersection([.control,.option,.shift,.command])
            if event.keyCode == UInt16(kVK_Space), actual == wanted, !event.isARepeat {
                self?.action(); return nil
            }
            return event
        }
        let modifiers = UInt32(controlKey | (alternate ? shiftKey : optionKey))
        RegisterEventHotKey(UInt32(kVK_Space), modifiers, EventHotKeyID(signature:0x50524D42,id:1), GetApplicationEventTarget(), 0, &reference)
    }
    deinit { if let localMonitor { NSEvent.removeMonitor(localMonitor) }; if let reference { UnregisterEventHotKey(reference) }; if let handler { RemoveEventHandler(handler) } }
}
