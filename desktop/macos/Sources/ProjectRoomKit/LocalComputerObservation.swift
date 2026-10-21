import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

public struct LocalScreenshot {
    public let png: Data
    public let width: Int
    public let height: Int
    public let windowID: UInt32
    public init(png: Data, width: Int, height: Int, windowID: UInt32) {
        self.png = png; self.width = width; self.height = height; self.windowID = windowID
    }
}

// Injectable observations let acceptance tests use only their own synthetic data.
// The production implementation never requests TCC permission as a side effect.
public protocol LocalComputerObserving {
    func appState(processID: Int32?) throws -> [String: Any]
    func screenshot(windowID: UInt32) throws -> LocalScreenshot
}
public final class LocalComputerObservation: LocalComputerObserving {
    public init() {}
    public static func fields(role: String, subrole: String?, title: String?, value: String?) -> [String: Any] {
        var result: [String: Any] = ["role": String(role.prefix(128))]
        if let subrole { result["subrole"] = String(subrole.prefix(128)) }
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { result["redacted"] = true; return result }
        if let title { result["title"] = String(title.prefix(512)) }
        if let value { result["value"] = String(value.prefix(512)) }
        return result
    }
    public func appState(processID: Int32?) throws -> [String: Any] {
        guard AXIsProcessTrusted() else { throw LocalToolFailure("accessibility_permission_required") }
        let application: NSRunningApplication?
        if let processID { application = NSRunningApplication(processIdentifier: processID) }
        else if Thread.isMainThread { application = NSWorkspace.shared.frontmostApplication }
        else { application = DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication } }
        guard let application, !application.isTerminated else { throw LocalToolFailure("application_unavailable") }
        let root = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.2)
        var count = 0, truncated = false
        func attribute(_ element: AXUIElement, _ name: String) -> Any? {
            var value: CFTypeRef?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
        }
        let deadline = Date().addingTimeInterval(3)
        func node(_ element: AXUIElement, depth: Int) -> [String: Any] {
            count += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? "unknown"
            let subrole = attribute(element, kAXSubroleAttribute) as? String
            let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
            var result = Self.fields(role: role, subrole: subrole,
                title: secure ? nil : attribute(element, kAXTitleAttribute) as? String,
                value: secure ? nil : attribute(element, kAXValueAttribute) as? String)
            if secure { return result } // Do not traverse descendants of secure fields.
            if let enabled = attribute(element, kAXEnabledAttribute) as? Bool { result["enabled"] = enabled }
            if depth < 4, count < 80, Date() < deadline {
                let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
                var rows = [[String: Any]]()
                for child in children {
                    if count >= 80 || Date() >= deadline { truncated = true; break }
                    rows.append(node(child, depth: depth + 1))
                }
                if !rows.isEmpty { result["children"] = rows }
            } else { truncated = true }
            return result
        }
        let tree = node(root, depth: 0)
        let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
            .filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == application.processIdentifier }
            .prefix(32).compactMap { item -> [String: Any]? in
                guard let id = (item[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { return nil }
                return ["windowId": id, "bounds": item[kCGWindowBounds as String] ?? [:]]
            }
        return ["processId": application.processIdentifier, "bundleId": application.bundleIdentifier ?? "", "name": application.localizedName ?? "",
            "tree": tree, "windows": windows, "nodeCount": count, "truncated": truncated, "capturedAt": ISO8601DateFormatter().string(from: Date())]
    }
    public func screenshot(windowID: UInt32) throws -> LocalScreenshot {
        guard CGPreflightScreenCaptureAccess() else { throw LocalToolFailure("screen_capture_permission_required") }
        // This synchronous broker entry point must never block the app's UI queue.
        guard !Thread.isMainThread else { throw LocalToolFailure("capture_requires_background_connection") }
        let done = DispatchSemaphore(value: 0), resultLock = NSLock()
        var result: Result<LocalScreenshot, Error>?
        func complete(_ value: Result<LocalScreenshot, Error>) { resultLock.lock(); result = value; resultLock.unlock(); done.signal() }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, error in
            guard error == nil, let window = content?.windows.first(where: { $0.windowID == windowID }) else { complete(.failure(LocalToolFailure("capture_window_unavailable"))); return }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            let scale = min(1, 2048 / max(window.frame.width, window.frame.height, 1))
            configuration.width = max(1, Int(window.frame.width * scale)); configuration.height = max(1, Int(window.frame.height * scale))
            configuration.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, error in
                guard error == nil, let image else { complete(.failure(LocalToolFailure("screen_capture_failed"))); return }
                let data = NSMutableData()
                guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { complete(.failure(LocalToolFailure("screen_capture_failed"))); return }
                CGImageDestinationAddImage(destination, image, nil)
                guard CGImageDestinationFinalize(destination), data.length <= 16777216 else { complete(.failure(LocalToolFailure("screen_capture_too_large"))); return }
                complete(.success(LocalScreenshot(png: data as Data, width: image.width, height: image.height, windowID: windowID)))
            }
        }
        guard done.wait(timeout: .now() + 10) == .success else { throw LocalToolFailure("screen_capture_timeout") }
        resultLock.lock(); defer { resultLock.unlock() }
        return try result!.get()
    }
}
