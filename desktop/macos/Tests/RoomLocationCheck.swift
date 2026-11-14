import Foundation

@main struct RoomLocationCheck {
    static func main() {
        var checks = 0
        func expect(_ result: Bool, _ label: String) {
            precondition(result, label); checks += 1
        }
        let origin = URL(string: "https://room.example:8443")!
        expect(RoomLocation.validSelfHostedOrigin(origin), "explicit HTTPS origin")
        for value in ["http://room.example", "https://user:secret@room.example", "https://room.example/path", "https://room.example?x=1", "https://room.example#fragment", "file:///tmp/room", "https://room.example:0", "https://room.example:65536"] {
            expect(!RoomLocation.validSelfHostedOrigin(URL(string: value)!), "refuse origin \(value)")
        }
        expect(RoomLocation.allowed(URL(string: "https://room.example:8443/r/commons")!, selfHostedOrigin: origin), "selected room path")
        for value in ["https://room.example", "https://other.example:8443", "http://room.example:8443", "https://user@room.example:8443", "https://room.example.evil:8443", "https://room.trydemigod.com", "http://127.0.0.1:4173"] {
            expect(!RoomLocation.allowed(URL(string: value)!, selfHostedOrigin: origin), "selected scope refuses \(value)")
        }
        expect(!RoomLocation.allowed(origin), "no implicit self-host trust")
        expect(RoomLocation.allowed(URL(string: "https://room.trydemigod.com/r/test")!), "hosted preserved")
        expect(RoomLocation.allowed(URL(string: "http://127.0.0.1:4173")!), "local preserved")
        expect(!RoomLocation.allowed(URL(string: "http://remote.example")!), "no remote plaintext")
        expect(!RoomLocation.allowed(origin, selfHostedOrigin: URL(string: "http://room.example:8443")!), "invalid selection fails closed")
        expect(RoomLocation.sameOrigin(origin, URL(string: "https://room.example:8443/r/test")!), "navigation same origin")
        expect(!RoomLocation.sameOrigin(origin, URL(string: "https://room.example:8444")!), "navigation port boundary")
        print("RoomLocation policy: \(checks) checks PASS")
    }
}
