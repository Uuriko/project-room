// Synthetic loopback WKWebView lifecycle owner; never shipped in the app bundle.
import AppKit
import WebKit
import AuthenticationServices
import ProjectRoomKit

@MainActor final class SyntheticAuthentication: RoomAuthenticationSession {
    weak var presentationContextProvider: ASWebAuthenticationPresentationContextProviding?
    let callback: (URL?, Error?) -> Void
    var started = 0
    let startResult: Bool
    let state: String
    let browserStart: URL?
    let provider: String?
    init(state: String, startResult: Bool, browserStart: URL?, provider: String?, callback: @escaping (URL?, Error?) -> Void) { self.state = state; self.startResult = startResult; self.browserStart = browserStart; self.provider = provider; self.callback = callback }
    func start() -> Bool {
        started += 1
        if startResult, let browserStart {
            Task { @MainActor in
                let client = URLSession(configuration: .ephemeral)
                defer { client.invalidateAndCancel() }
                do {
                    var bridge = URLComponents(url: browserStart, resolvingAgainstBaseURL: false)!
                    bridge.path = "/__native_acceptance__/browser-complete"
                    bridge.queryItems = [URLQueryItem(name: "start", value: browserStart.absoluteString)]
                    let (data, response) = try await client.data(from: bridge.url!)
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let result = try JSONSerialization.jsonObject(with: data) as? [String: String],
                          let callbackString = result["callback"], let callbackURL = URL(string: callbackString) else { fatalError("Real browser consent did not return a native callback") }
                    callback(callbackURL, nil)
                } catch { callback(nil, error) }
            }
        }
        return startResult
    }
    func cancel() { callback(nil, NSError(domain: ASWebAuthenticationSessionErrorDomain, code: ASWebAuthenticationSessionError.Code.canceledLogin.rawValue)) }
}
@MainActor final class Acceptance: NSObject, NSApplicationDelegate {
    let url: URL
    var room: RoomWindow?
    var sessions: [SyntheticAuthentication] = []
    var nextStartResult = true
    var completeWithRealBrowser = false
    init(url: URL) { self.url = url }
    func applicationDidFinishLaunching(_ notification: Notification) {
        room = RoomWindow(url: url, isolated: true, acceptanceAuthenticationFactory: { [unowned self] url, scheme, callback in
            guard scheme == "projectroom", url.path == "/api/auth/desktop/start" else { fatalError("Wrong native start") }
            let params = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            guard params.first(where: { $0.name == "state" })?.value?.count == 43,
                  params.first(where: { $0.name == "challenge" })?.value?.count == 43 else { fatalError("Missing state/PKCE proof") }
            let session = SyntheticAuthentication(state: params.first(where: { $0.name == "state" })!.value!, startResult: nextStartResult, browserStart: completeWithRealBrowser ? url : nil, provider: params.first(where: { $0.name == "provider" })?.value, callback: callback); sessions.append(session); return session
        })
        room?.show()
        Task { @MainActor in
            do {
                guard let room else { exit(1) }
                for _ in 0..<100 {
                    let ready = try? await room.webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === false") as? Bool
                    if ready == true { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                // Select the real minimal entrance choice and activate its provider link.
                // A rapid menu invocation overlaps the actual WK navigation callback.
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#auth-signin-ui [data-password-mode=login]').click(); document.querySelector('#google-signin').click(); true")
                room.signIn()
                try await Task.sleep(nanoseconds: 1_000_000_000)
                fputs("NATIVE_AUTH_ATTEMPTS \(sessions.count)\n", stderr)
                guard sessions.count == 1, sessions[0].started == 1 else { fatalError("Overlapping browser authentication sessions") }
                guard room.webView.isHidden else { fatalError("App must fence account changes during authentication") }
                sessions[0].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { fatalError("Cancellation left the app hidden") }
                @MainActor func labels(_ view: NSView) -> [String] { ((view as? NSTextField).map { [$0.stringValue] } ?? []) + view.subviews.flatMap(labels) }
                guard let content = room.window.contentView, labels(content).contains("Sign-in cancelled. Your room is unchanged."), room.window.attachedSheet == nil else { fatalError("Actual canceledLogin must use cancellation copy without a failure dialog") }
                print("NATIVE_AUTH_SINGLE_ATTEMPT passed; cancel restores visible app")
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#google-signin').click(); true")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 2, sessions[1].provider == "google", room.webView.isHidden else { fatalError("Retry did not start a new isolated attempt") }
                sessions[0].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard room.webView.isHidden else { fatalError("A stale callback cleared the newer attempt") }
                let denied = URL(string: "projectroom://auth?error=access_denied&state=\(sessions[1].state)")!
                sessions[1].callback(denied, nil)
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { fatalError("Provider cancellation left the app hidden") }
                print("NATIVE_AUTH_STALE_CALLBACK passed; provider cancellation restores visible app")
                nextStartResult = false
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 3, sessions[2].provider == nil, !room.webView.isHidden else { fatalError("Browser startup failure did not restore the app") }
                if let sheet = room.window.attachedSheet, let content = sheet.contentView {
                    @MainActor func findDefault(_ view: NSView) -> NSButton? {
                        if let button = view as? NSButton, (button.keyEquivalent == "\r" || button.title == "OK") { return button }
                        return view.subviews.lazy.compactMap { findDefault($0) }.first
                    }
                    guard let button = findDefault(content) else { fatalError("Failure must offer a visible recovery acknowledgement") }
                    button.performClick(nil)
                } else { fatalError("Browser startup failure must explain recovery") }
                nextStartResult = true
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 4, room.webView.isHidden else { fatalError("A startup failure kept the next retry locked") }
                sessions[3].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { fatalError("Final cancellation did not restore the original app") }
                print("NATIVE_AUTH_START_FAILURE passed; visible explanation and new retry")
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 5, room.webView.isHidden else { fatalError("Browser error owner requires a current attempt") }
                sessions[4].callback(nil, NSError(domain: "synthetic browser failure", code: 29, userInfo: [NSLocalizedDescriptionKey: "SECRET raw provider detail"]))
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden, let failure = room.window.attachedSheet?.contentView else { fatalError("Non-cancellation browser failure must restore app and explain retry") }
                @MainActor func descendantViews(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendantViews) }
                let failureText = descendantViews(failure).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " ")
                guard failureText.contains("Try again"), failureText.contains("email and password"), !failureText.contains("cancelled"), !failureText.contains("SECRET") else { fatalError("Browser failure was mislabeled cancellation or leaked raw details") }
                guard let acknowledgement = descendantViews(failure).compactMap({ $0 as? NSButton }).first(where: { $0.keyEquivalent == "\r" || $0.title == "OK" }) else { fatalError("Browser failure requires a visible acknowledgement") }
                acknowledgement.performClick(nil)
                print("NATIVE_AUTH_BROWSER_ERROR passed; failure distinguished from cancellation and app restored")
                _ = try await room.webView.evaluateJavaScript("window.location.href = '/api/auth/github/start'; true")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 6, sessions[5].provider == "github", room.webView.isHidden else { fatalError("GitHub choice did not survive native handoff") }
                sessions[5].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { fatalError("GitHub cancellation did not restore app") }
                print("NATIVE_AUTH_PROVIDER_INTENT passed; Google/GitHub preserved; generic menu omits provider")
                completeWithRealBrowser = true
                _ = try await room.webView.evaluateJavaScript("history.replaceState(null, '', '/?native_return=preserved'); document.querySelector('#google-signin').click(); true")
                var nativeSession: [String: Any]?
                for _ in 0..<200 {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    if room.webView.isHidden { continue }
                    let raw = try? await room.webView.callAsyncJavaScript("return await (await fetch('/api/account-session')).json();", arguments: [:], in: nil, contentWorld: .page)
                    if let result = raw as? [String: Any], result["authenticated"] as? Bool == true { nativeSession = result; break }
                }
                guard sessions.count == 7, sessions[6].provider == "google", !room.webView.isHidden,
                      let account = nativeSession?["account"] as? [String: Any], account["id"] as? String == "google:123456789012345678901" else { fatalError("Native cookie installation did not produce the real Google account") }
                let cookies = await withCheckedContinuation { continuation in
                    room.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
                }
                guard let cookie = cookies.first(where: { $0.name == "account_session" || $0.name == "__Host-account_session" }), cookie.isHTTPOnly else { fatalError("Native account cookie must remain HttpOnly") }
                let scriptCookie = try await room.webView.evaluateJavaScript("document.cookie") as? String ?? ""
                guard !scriptCookie.contains("account_session") else { fatalError("JavaScript gained access to the account cookie") }
                var visibleAccount = false
                for _ in 0..<100 {
                    let visible = try? await room.webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === true && document.querySelector('#account-settings-button')?.hidden === false && ['#main', '#inbox-panel'].some(selector => { const element = document.querySelector(selector); return element && !element.hidden && element.getClientRects().length > 0; })")
                    if visible as? Bool == true { visibleAccount = true; break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                let uiState = try await room.webView.evaluateJavaScript("JSON.stringify({href:location.href,accountSignedIn:document.body.dataset.accountSignedIn,authHidden:document.querySelector('#auth-panel')?.hidden,mainHidden:document.querySelector('#main')?.hidden,inboxHidden:document.querySelector('#inbox-panel')?.hidden,inboxHeight:document.querySelector('#inbox-panel')?.getBoundingClientRect().height})")
                print("NATIVE_AUTH_VISIBLE_STATE \(uiState)")
                guard visibleAccount else { fputs("NATIVE_AUTH_VISIBLE_WORKSPACE_FAILED: authenticated cookie did not restore visible signed-in workspace\n", stderr); exit(1) }
                let returnPreserved = try await room.webView.evaluateJavaScript("new URL(location.href).searchParams.get('native_return') === 'preserved'")
                guard returnPreserved as? Bool == true else { fatalError("Native sign-in lost the original destination parameters") }
                print("NATIVE_AUTH_VISIBLE_WORKSPACE passed; account signed in and welcome hidden; return parameters retained")
                print("NATIVE_AUTH_REAL_GOOGLE_CALLBACK passed; actual PKCE201 and WK HttpOnly account readback")
                exit(0)
            } catch { fputs("NATIVE_AUTH_FAILED \(error)\n", stderr); exit(1) }
        }
    }
}
MainActor.assumeIsolated {
let args = CommandLine.arguments
 guard args.count == 2, let url = URL(string: args[1]), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else { fatalError("Loopback synthetic auth URL required") }
let app = NSApplication.shared; app.setActivationPolicy(.regular)
let delegate = Acceptance(url: url); app.delegate = delegate; app.run()
}
