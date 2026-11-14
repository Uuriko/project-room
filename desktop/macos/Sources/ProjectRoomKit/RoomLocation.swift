import Foundation

public enum RoomLocation {
    public static func allowed(_ url: URL, selfHostedOrigin: URL? = nil) -> Bool {
        guard url.user == nil, url.password == nil else { return false }
        if let origin = selfHostedOrigin {
            return validSelfHostedOrigin(origin) && sameOrigin(url, origin)
        }
        return (url.scheme == "https" && url.host == "room.trydemigod.com" && (url.port == nil || url.port == 443))
            || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? ""))
    }
    // Only an explicit launch argument selects an additional origin. No link,
    // redirect, discovery response, or stored web content may expand this scope.
    public static func validSelfHostedOrigin(_ url: URL) -> Bool {
        url.scheme == "https" && !(url.host ?? "").isEmpty
            && url.user == nil && url.password == nil
            && (url.path.isEmpty || url.path == "/")
            && url.query == nil && url.fragment == nil
            && (url.port == nil || (1...65535).contains(url.port!))
    }
    public static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }
}
