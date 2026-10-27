import XCTest
import WebKit
@testable import ProjectRoomKit

final class RoomProfilesTests: XCTestCase {
    @MainActor func testPriorRegistryFormatReopensExactNamedStore() async throws {
        // The prior native candidate used one {id,name} file per UUID. An
        // upgrade must reuse that UUID, not create a fresh browser identity.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let id = UUID()
        let bytes = Data("{\"id\":\"\(id.uuidString)\",\"name\":\"Prior candidate\"}".utf8)
        let record = directory.appendingPathComponent(id.uuidString + ".json")
        try bytes.write(to: record)
        let priorStore = WKWebsiteDataStore(forIdentifier: id)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "profile-upgrade.invalid", .path: "/", .name: "upgrade-session", .value: "synthetic-session", .expires: Date().addingTimeInterval(3600)]))
        await priorStore.httpCookieStore.setCookie(cookie)
        let loaded = try XCTUnwrap(RoomProfileStore(directory: directory).load().first)
        XCTAssertEqual(loaded.id, id)
        XCTAssertEqual(try Data(contentsOf: record), bytes)
        let reopened = loaded.websiteDataStore()
        let cookies = await reopened.httpCookieStore.allCookies()
        XCTAssertTrue(cookies.contains { $0.name == cookie.name && $0.value == cookie.value })
        await reopened.httpCookieStore.deleteCookie(cookie)
    }

    func testRegistryRoundTripAndDistinctIdentities() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RoomProfileStore(directory: directory)
        let human = try store.create(name: "Human")
        let agent = try store.create(name: "Agent")
        let another = try store.create(name: "Human")
        XCTAssertNotEqual(human.id, another.id)
        XCTAssertNotEqual(human.id, agent.id)
        XCTAssertEqual(Set(try RoomProfileStore(directory: directory).load().map(\.id)), Set([human.id, agent.id, another.id]))
    }

    func testInvalidNamesAndCorruptRegistryFailClosed() throws {
        for name in ["", "  ", "bad\nname", String(repeating: "x", count: 61)] {
            XCTAssertThrowsError(try RoomProfile(name: name))
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RoomProfileStore(directory: directory)
        let profile = try store.create(name: "Keep me")
        try Data("broken".utf8).write(to: directory.appendingPathComponent("broken.json"))
        XCTAssertThrowsError(try store.load())
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(profile.id.uuidString + ".json").path))
    }

    @MainActor func testCookiesDoNotCrossProfilesAndLogoutIsLocal() async throws {
        let human = try RoomProfile(name: "Test human")
        let agent = try RoomProfile(name: "Test agent")
        let humanStore = human.websiteDataStore()
        let agentStore = agent.websiteDataStore()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "profile-isolation.invalid", .path: "/", .name: "session", .value: "human-only"]))
        await humanStore.httpCookieStore.setCookie(cookie)
        let humanCookies = await humanStore.httpCookieStore.allCookies()
        let agentCookies = await agentStore.httpCookieStore.allCookies()
        XCTAssertTrue(humanCookies.contains { $0.value == "human-only" })
        XCTAssertFalse(agentCookies.contains { $0.name == "session" })
        let agentCookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "profile-isolation.invalid", .path: "/", .name: "session", .value: "agent-only"]))
        await agentStore.httpCookieStore.setCookie(agentCookie)
        await humanStore.httpCookieStore.deleteCookie(cookie)
        let loggedOut = await humanStore.httpCookieStore.allCookies()
        XCTAssertFalse(loggedOut.contains { $0.name == "session" })
        let surviving = await agentStore.httpCookieStore.allCookies()
        XCTAssertTrue(surviving.contains { $0.value == "agent-only" })
        await agentStore.httpCookieStore.deleteCookie(agentCookie)
        // Persistent test stores may be removed by a later process after WebKit releases them.
    }
}
