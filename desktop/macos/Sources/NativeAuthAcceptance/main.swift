// Synthetic loopback WKWebView lifecycle owner; never shipped in the app bundle.
import AppKit
import WebKit
import AuthenticationServices
import ProjectRoomKit

// A failed acceptance assertion is a test result, not an application crash.
// Exit nonzero without raising SIGTRAP and interrupting the user with macOS crash dialogs.
private func acceptanceFailure(_ message: String) -> Never {
    FileHandle.standardError.write(Data("NATIVE_AUTH_FAILURE: \(message)\n".utf8))
    exit(1)
}

@MainActor final class SyntheticAuthentication: RoomAuthenticationSession {
    weak var presentationContextProvider: ASWebAuthenticationPresentationContextProviding?
    let callback: (URL?, Error?) -> Void
    var started = 0
    var cancelled = 0
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
                          let callbackString = result["callback"], let callbackURL = URL(string: callbackString) else { acceptanceFailure("Real browser consent did not return a native callback") }
                    callback(callbackURL, nil)
                } catch { callback(nil, error) }
            }
        }
        return startResult
    }
    func cancel() { cancelled += 1; callback(nil, NSError(domain: ASWebAuthenticationSessionErrorDomain, code: ASWebAuthenticationSessionError.Code.canceledLogin.rawValue)) }
}
@MainActor final class Acceptance: NSObject, NSApplicationDelegate {
    let url: URL
    var room: RoomWindow?
    var sessions: [SyntheticAuthentication] = []
    var nextStartResult = true
    var completeWithRealBrowser = false
    var cookieCommitInstalled = false
    var releaseCookieCommit: CheckedContinuation<Void, Never>?
    init(url: URL) { self.url = url }
    func applicationDidFinishLaunching(_ notification: Notification) {
        room = RoomWindow(url: url, isolated: true, acceptanceAuthenticationFactory: { [unowned self] url, scheme, callback in
            guard scheme == "projectroom", url.path == "/api/auth/desktop/start" else { acceptanceFailure("Wrong native start") }
            let params = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
            guard params.first(where: { $0.name == "state" })?.value?.count == 43,
                  params.first(where: { $0.name == "challenge" })?.value?.count == 43 else { acceptanceFailure("Missing state/PKCE proof") }
            let session = SyntheticAuthentication(state: params.first(where: { $0.name == "state" })!.value!, startResult: nextStartResult, browserStart: completeWithRealBrowser ? url : nil, provider: params.first(where: { $0.name == "provider" })?.value, callback: callback); sessions.append(session); return session
        } , acceptanceCookieInstaller: { [unowned self] cookie, store in
            await store.setCookie(cookie)
            cookieCommitInstalled = true
            await withCheckedContinuation { releaseCookieCommit = $0 }
        }, acceptanceCookieCommitTimeoutNanoseconds: 1_000_000_000)
        room?.show()
        Task { @MainActor in
            do {
                guard let room else { exit(1) }
                for _ in 0..<100 {
                    let ready = try? await room.webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === false") as? Bool
                    if ready == true { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                @MainActor func nativeBack() {
                    func buttons(_ view: NSView) -> [NSButton] { ((view as? NSButton).map { [$0] } ?? []) + view.subviews.flatMap(buttons) }
                    guard let root = room.window.contentView, let back = buttons(root).first(where: { $0.title == "Back" }) else { acceptanceFailure("Actual native Back control missing") }
                    back.performClick(nil)
                }
                // Cancel before the asynchronous account-slot read can complete.
                room.signIn(); nativeBack()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.isEmpty, !room.webView.isHidden else { acceptanceFailure("Back during pending account read must prevent browser launch") }
                print("NATIVE_AUTH_BACK_PRE_READ passed; actual toolbar cancels before async account read")
                room.signIn()
                guard let root = room.window.contentView, let cancel = descendantViews(root).compactMap({ $0 as? NSButton }).first(where: { $0.title == "Cancel sign-in" }), !cancel.isHidden, cancel.isEnabled else { acceptanceFailure("Pending sign-in needs a visible Cancel action") }
                cancel.performClick(nil)
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.isEmpty, !room.webView.isHidden, cancel.isHidden else { acceptanceFailure("Cancel did not retire pending account read") }
                room.signIn()
                guard let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: room.window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53), room.window.performKeyEquivalent(with: escape) else { acceptanceFailure("Escape must activate native sign-in cancellation") }
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.isEmpty, !room.webView.isHidden, cancel.isHidden else { acceptanceFailure("Escape did not retire pending account read") }
                print("NATIVE_AUTH_CANCEL_ESCAPE passed; visible Cancel and actual Escape key binding restore app")
                // Select the real minimal entrance choice and activate its provider link.
                // A rapid menu invocation overlaps the actual WK navigation callback.
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#auth-signin-ui [data-password-mode=login]')?.click(); document.querySelector('#google-signin').click(); true")
                room.signIn()
                try await Task.sleep(nanoseconds: 1_000_000_000)
                fputs("NATIVE_AUTH_ATTEMPTS \(sessions.count)\n", stderr)
                guard sessions.count == 1, sessions[0].started == 1 else { acceptanceFailure("Overlapping browser authentication sessions") }
                guard room.webView.isHidden else { acceptanceFailure("App must fence account changes during authentication") }
                nativeBack()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { acceptanceFailure("Cancellation left the app hidden") }
                @MainActor func labels(_ view: NSView) -> [String] { ((view as? NSTextField).map { [$0.stringValue] } ?? []) + view.subviews.flatMap(labels) }
                guard let content = room.window.contentView, labels(content).contains("Sign-in cancelled. Your room is unchanged."), room.window.attachedSheet == nil else { acceptanceFailure("Actual canceledLogin must use cancellation copy without a failure dialog") }
                print("NATIVE_AUTH_SINGLE_ATTEMPT passed; actual Back cancels held browser and restores visible app")
                _ = try await room.webView.evaluateJavaScript("document.querySelector('#google-signin').click(); true")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 2, sessions[1].provider == "google", room.webView.isHidden else { acceptanceFailure("Retry did not start a new isolated attempt") }
                sessions[0].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard room.webView.isHidden else { acceptanceFailure("A stale callback cleared the newer attempt") }
                let denied = URL(string: "projectroom://auth?error=access_denied&state=\(sessions[1].state)")!
                sessions[1].callback(denied, nil)
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { acceptanceFailure("Provider cancellation left the app hidden") }
                print("NATIVE_AUTH_STALE_CALLBACK passed; provider cancellation restores visible app")
                nextStartResult = false
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 3, sessions[2].provider == nil, !room.webView.isHidden else { acceptanceFailure("Browser startup failure did not restore the app") }
                if let sheet = room.window.attachedSheet, let content = sheet.contentView {
                    @MainActor func findDefault(_ view: NSView) -> NSButton? {
                        if let button = view as? NSButton, (button.keyEquivalent == "\r" || button.title == "OK") { return button }
                        return view.subviews.lazy.compactMap { findDefault($0) }.first
                    }
                    guard let button = findDefault(content) else { acceptanceFailure("Failure must offer a visible recovery acknowledgement") }
                    button.performClick(nil)
                } else { acceptanceFailure("Browser startup failure must explain recovery") }
                nextStartResult = true
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 4, room.webView.isHidden else { acceptanceFailure("A startup failure kept the next retry locked") }
                sessions[3].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { acceptanceFailure("Final cancellation did not restore the original app") }
                print("NATIVE_AUTH_START_FAILURE passed; visible explanation and new retry")
                room.signIn()
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 5, room.webView.isHidden else { acceptanceFailure("Browser error owner requires a current attempt") }
                sessions[4].callback(nil, NSError(domain: "synthetic browser failure", code: 29, userInfo: [NSLocalizedDescriptionKey: "SECRET raw provider detail"]))
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden, let failure = room.window.attachedSheet?.contentView else { acceptanceFailure("Non-cancellation browser failure must restore app and explain retry") }
                @MainActor func descendantViews(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendantViews) }
                let failureText = descendantViews(failure).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " ")
                guard failureText.contains("Try again"), failureText.contains("email and password"), !failureText.contains("cancelled"), !failureText.contains("SECRET") else { acceptanceFailure("Browser failure was mislabeled cancellation or leaked raw details") }
                guard let acknowledgement = descendantViews(failure).compactMap({ $0 as? NSButton }).first(where: { $0.keyEquivalent == "\r" || $0.title == "OK" }) else { acceptanceFailure("Browser failure requires a visible acknowledgement") }
                acknowledgement.performClick(nil)
                print("NATIVE_AUTH_BROWSER_ERROR passed; failure distinguished from cancellation and app restored")
                _ = try await room.webView.evaluateJavaScript("window.location.href = '/api/auth/github/start'; true")
                try await Task.sleep(nanoseconds: 500_000_000)
                guard sessions.count == 6, sessions[5].provider == "github", room.webView.isHidden else { acceptanceFailure("GitHub choice did not survive native handoff") }
                sessions[5].cancel()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard !room.webView.isHidden else { acceptanceFailure("GitHub cancellation did not restore app") }
                print("NATIVE_AUTH_PROVIDER_INTENT passed; Google/GitHub preserved; generic menu omits provider")
                completeWithRealBrowser = true
                _ = try await room.webView.evaluateJavaScript("history.replaceState(null, '', '/?native_return=preserved&oauth=old&oauth=duplicate#pr-view/inbox'); document.querySelector('#google-signin').click(); true")
                for _ in 0..<200 {
                    if cookieCommitInstalled { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard cookieCommitInstalled, room.webView.isHidden else { acceptanceFailure("Held actual WK cookie commit must still fence the app") }
                let savedHint = try await room.webView.evaluateJavaScript("localStorage.getItem('pr-had-account') === '1'")
                guard savedHint as? Bool == true else { acceptanceFailure("Queued-cookie recovery must preserve non-secret startup probe hint") }
                nativeBack(); room.signIn()
                try await Task.sleep(nanoseconds: 100_000_000)
                guard sessions.count == 7, room.webView.isHidden else { acceptanceFailure("Back during queued cookie commit must not retire it or start a replacement attempt") }
                let committed = try await room.webView.callAsyncJavaScript("return (await (await fetch('/api/account-session')).json()).authenticated;", arguments: [:], in: nil, contentWorld: .page)
                guard committed as? Bool == true else { acceptanceFailure("Cookie commit owner must use an actually installed WK account cookie") }
                for _ in 0..<100 {
                    if room.window.attachedSheet != nil { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                guard let uncertain = room.window.attachedSheet?.contentView else { acceptanceFailure("Held cookie callback must report bounded confirmation failure") }
                let uncertainText = descendantViews(uncertain).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " ")
                guard uncertainText.contains("couldn’t confirm"), !uncertainText.contains("unchanged"), !uncertainText.contains("cancelled") else { acceptanceFailure("Unknown cookie commit must not claim cancellation or unchanged account") }
                guard let uncertainOK = descendantViews(uncertain).compactMap({ $0 as? NSButton }).first(where: { $0.keyEquivalent == "\r" || $0.title == "OK" }) else { acceptanceFailure("Cookie confirmation recovery acknowledgement missing") }
                uncertainOK.performClick(nil)
                nativeBack(); room.signIn()
                guard room.webView.isHidden, sessions.count == 7 else { acceptanceFailure("Unknown queued cookie commit must keep replacement sign-in fenced") }
                guard let release = releaseCookieCommit else { acceptanceFailure("Held real cookie completion missing") }
                releaseCookieCommit = nil; release.resume()
                print("NATIVE_AUTH_COOKIE_COMMIT passed; real cookie installed, Back fenced, bounded unknown report and late completion retained")
                var nativeSession: [String: Any]?
                for _ in 0..<200 {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    if room.webView.isHidden { continue }
                    let raw = try? await room.webView.callAsyncJavaScript("return await (await fetch('/api/account-session')).json();", arguments: [:], in: nil, contentWorld: .page)
                    if let result = raw as? [String: Any], result["authenticated"] as? Bool == true { nativeSession = result; break }
                }
                guard sessions.count == 7, sessions[6].provider == "google", !room.webView.isHidden,
                      let account = nativeSession?["account"] as? [String: Any], account["id"] as? String == "google:123456789012345678901" else { acceptanceFailure("Native cookie installation did not produce the real Google account") }
                let cookies = await withCheckedContinuation { continuation in
                    room.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
                }
                guard let cookie = cookies.first(where: { $0.name == "account_session" || $0.name == "__Host-account_session" }), cookie.isHTTPOnly else { acceptanceFailure("Native account cookie must remain HttpOnly") }
                let scriptCookie = try await room.webView.evaluateJavaScript("document.cookie") as? String ?? ""
                guard !scriptCookie.contains("account_session") else { acceptanceFailure("JavaScript gained access to the account cookie") }
                var visibleAccount = false
                for _ in 0..<100 {
                    let visible = try? await room.webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === true && document.querySelector('#account-settings-button')?.hidden === false && document.querySelector('#account-settings-button')?.disabled === false && ['#main', '#inbox-panel'].some(selector => { const element = document.querySelector(selector); return element && !element.hidden && element.getClientRects().length > 0; })")
                    if visible as? Bool == true { visibleAccount = true; break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                let uiState = try await room.webView.evaluateJavaScript("JSON.stringify({href:location.href,accountSignedIn:document.body.dataset.accountSignedIn,authHidden:document.querySelector('#auth-panel')?.hidden,mainHidden:document.querySelector('#main')?.hidden,inboxHidden:document.querySelector('#inbox-panel')?.hidden,inboxHeight:document.querySelector('#inbox-panel')?.getBoundingClientRect().height})")
                print("NATIVE_AUTH_VISIBLE_STATE \(uiState)")
                guard visibleAccount else { fputs("NATIVE_AUTH_VISIBLE_WORKSPACE_FAILED: authenticated cookie did not restore visible signed-in workspace\n", stderr); exit(1) }
                let returnPreserved = try await room.webView.evaluateJavaScript("new URL(location.href).searchParams.get('native_return') === 'preserved' && new URL(location.href).searchParams.getAll('oauth').join(',') === 'login' && location.hash === '#pr-view/inbox'")
                guard returnPreserved as? Bool == true else { acceptanceFailure("Native sign-in lost the original destination parameters") }
                print("NATIVE_AUTH_VISIBLE_WORKSPACE passed; account signed in and welcome hidden; return parameters retained")
                print("NATIVE_AUTH_REAL_GOOGLE_CALLBACK passed; actual PKCE201 and WK HttpOnly account readback")
                for (limit, expectBrowser) in [(UInt64(20_000_000), false), (UInt64(450_000_000), true)] {
                    var held: [SyntheticAuthentication] = []
                    let timeoutRoom = RoomWindow(url: self.url, isolated: true, acceptanceAuthenticationFactory: { start, _, callback in
                        let state = URLComponents(url: start, resolvingAgainstBaseURL: false)!.queryItems!.first(where: { $0.name == "state" })!.value!
                        let session = SyntheticAuthentication(state: state, startResult: true, browserStart: nil, provider: nil, callback: callback)
                        held.append(session); return session
                    }, acceptanceAuthenticationTimeoutNanoseconds: limit)
                    timeoutRoom.show()
                    for _ in 0..<100 {
                        let ready = try? await timeoutRoom.webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === false")
                        if ready as? Bool == true { break }
                        try await Task.sleep(nanoseconds: 50_000_000)
                    }
                    timeoutRoom.signIn()
                    try await Task.sleep(nanoseconds: 800_000_000)
                    guard !timeoutRoom.webView.isHidden, held.count == (expectBrowser ? 1 : 0), let sheet = timeoutRoom.window.attachedSheet?.contentView else { acceptanceFailure("Pending timeout must restore app and explain retry before or after browser launch") }
                    let text = descendantViews(sheet).compactMap { ($0 as? NSTextField)?.stringValue }.joined(separator: " ")
                    guard text.contains("took too long"), text.contains("email and password"), held.allSatisfy({ $0.cancelled == 1 }) else { acceptanceFailure("Timeout must cancel held browser once and offer email recovery") }
                    guard let ok = descendantViews(sheet).compactMap({ $0 as? NSButton }).first(where: { $0.keyEquivalent == "\r" || $0.title == "OK" }) else { acceptanceFailure("Timeout recovery acknowledgement missing") }
                    ok.performClick(nil)
                    held.first?.callback(nil, NSError(domain: "stale timeout callback", code: 1))
                    try await Task.sleep(nanoseconds: 50_000_000)
                    guard timeoutRoom.window.attachedSheet == nil, !timeoutRoom.webView.isHidden else { acceptanceFailure("Stale callback resurrected timed-out attempt") }
                    timeoutRoom.signIn(); timeoutRoom.back()
                    try await Task.sleep(nanoseconds: 800_000_000)
                    guard timeoutRoom.window.attachedSheet == nil, !timeoutRoom.webView.isHidden, held.count == (expectBrowser ? 1 : 0) else { acceptanceFailure("Retry/cancel did not retire its timer or pending read") }
                    timeoutRoom.window.orderOut(nil)
                    print("NATIVE_AUTH_TIMEOUT passed; browserStarted=\(expectBrowser); recovery, stale callback and retry cancellation")
                }
                exit(0)
            } catch { fputs("NATIVE_AUTH_FAILED \(error)\n", stderr); exit(1) }
        }
    }
}
MainActor.assumeIsolated {
let args = CommandLine.arguments
 guard args.count == 2, let url = URL(string: args[1]), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else { acceptanceFailure("Loopback synthetic auth URL required") }
let app = NSApplication.shared; app.setActivationPolicy(.regular)
let delegate = Acceptance(url: url); app.delegate = delegate; app.run()
}
