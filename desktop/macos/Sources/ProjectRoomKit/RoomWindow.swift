import AppKit
import WebKit
import AuthenticationServices
import CryptoKit
import Security

public enum RoomLocation {
    public static func allowed(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil else { return false }
        return (url.scheme == "https" && url.host == "room.trydemigod.com" && (url.port == nil || url.port == 443))
            || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? ""))
    }
    public static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port && url.user == nil && url.password == nil
    }
}

@MainActor public protocol RoomAuthenticationSession: AnyObject {
    var presentationContextProvider: ASWebAuthenticationPresentationContextProviding? { get set }
    func start() -> Bool
    func cancel()
}
extension ASWebAuthenticationSession: RoomAuthenticationSession {}
public typealias RoomAuthenticationFactory = @MainActor (URL, String, @escaping (URL?, Error?) -> Void) -> any RoomAuthenticationSession

@MainActor public final class RoomWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, ASWebAuthenticationPresentationContextProviding {
    public let window: NSWindow
    public let webView: WKWebView
    public let origin: URL
    private let status = NSTextField(labelWithString: "Connecting…")
    private var localTools: LocalToolsWindow?
    private var authentication: (any RoomAuthenticationSession)?
    private let acceptanceAuthenticationFactory: RoomAuthenticationFactory?
    private var wakeObserver: NSObjectProtocol?
    private var pendingDestination: URL?
    private var signInPending = false
    private var signInAttempt: UUID?
    private var authenticationCallbackPending = false
    private var signInSlot: String?
    private var cancelledDownloads = Set<ObjectIdentifier>()
    private let acceptanceDownloadDestination: ((String) -> URL?)?
    public private(set) var completedDownloadCount = 0
    public private(set) var failedDownloadCount = 0

    public init(url: URL, isolated: Bool = false, acceptanceDownloadDestination: ((String) -> URL?)? = nil, acceptanceAuthenticationFactory: RoomAuthenticationFactory? = nil) {
        precondition(RoomLocation.allowed(url))
        // Destination overrides are restricted to isolated loopback acceptance.
        precondition(acceptanceDownloadDestination == nil || (isolated && url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")))
        precondition(acceptanceAuthenticationFactory == nil || (isolated && url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")))
        self.acceptanceAuthenticationFactory = acceptanceAuthenticationFactory
        self.acceptanceDownloadDestination = acceptanceDownloadDestination
        self.origin = URL(string: "\(url.scheme!)://\(url.host!)\(url.port.map { ":\($0)" } ?? "")")!
        let config = WKWebViewConfiguration()
        config.websiteDataStore = isolated ? .nonPersistent() : .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.applicationNameForUserAgent = "ProjectRoomMac/0.1"
        webView = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Project Room"
        window.minSize = NSSize(width: 480, height: 480)
        window.isReleasedWhenClosed = false
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.underPageBackgroundColor = .windowBackgroundColor
        let container = NSView()
        window.contentView = container
        let bar = NSStackView()
        bar.orientation = .horizontal; bar.spacing = 8
        for (title, action) in [("Back", #selector(back)), ("Reload", #selector(reload)), ("Go to…", #selector(goTo)), ("My Mac", #selector(showMyMac))] {
            let button = NSButton(title: title, target: self, action: action)
            button.bezelStyle = .rounded; bar.addArrangedSubview(button)
        }
        status.font = .systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        bar.addArrangedSubview(status)
        for view in [bar, webView] { view.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(view) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: container.topAnchor, constant: 8), bar.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12), bar.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -12),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8), webView.bottomAnchor.constraint(equalTo: container.bottomAnchor), webView.leadingAnchor.constraint(equalTo: container.leadingAnchor), webView.trailingAnchor.constraint(equalTo: container.trailingAnchor)
        ])
        window.center()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, let current = self.webView.url, RoomLocation.sameOrigin(current, self.origin) else { return }
                // Existing shared owner revalidates availability without replaying writes.
                self.webView.evaluateJavaScript("window.dispatchEvent(new Event('pageshow'))", completionHandler: nil)
            }
        }
        open(url)
    }

    public func show() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    public func open(_ url: URL) {
        guard RoomLocation.sameOrigin(url, origin) else { return }
        webView.load(URLRequest(url: url))
    }
    public func windowShouldClose(_ sender: NSWindow) -> Bool { window.orderOut(nil); return false }
    @objc public func back() { if !signInPending { webView.goBack() } }
    @objc public func forward() { if !signInPending { webView.goForward() } }
    @objc public func reload() { if !signInPending { webView.reload() } }
    @objc public func goTo() {
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return }
        webView.evaluateJavaScript("document.querySelector('#room-actions-open')?.click()", completionHandler: nil)
    }
    @objc public func signIn() { signIn(provider: nil) }
    private func signIn(provider: String?) {
        guard !signInPending else { return }
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return }
        // Reserve the attempt before either asynchronous WebKit call. A provider
        // click and menu action must not launch competing browser sessions.
        let attempt = UUID()
        signInAttempt = attempt
        signInPending = true
        webView.evaluateJavaScript("document.querySelector('#auth-panel')?.hidden === false && document.querySelector('#auth-signin-ui')?.getAttribute('aria-busy') !== 'true'") { [weak self] value, _ in
            guard let self, self.currentAuthentication(attempt) else { return }
            guard value as? Bool == true else { self.endAuthentication(attempt); self.tell("Open Account and sign out before signing in with a different account."); return }
            Task { @MainActor in
                do {
                    let slot = try await self.webView.callAsyncJavaScript("const s = await (await fetch('/api/account-session')).json(); if(s.authenticated) throw new Error('Already signed in'); return JSON.stringify([s.sessionBinding,s.sessionRevision]);", arguments: [:], in: nil, contentWorld: .page)
                    guard self.currentAuthentication(attempt) else { return }
                    guard let tuple = slot as? String else { self.endAuthentication(attempt); return }
                    self.signInSlot = tuple
                    self.webView.isHidden = true
                    self.beginAuthentication(attempt, provider: provider)
                } catch {
                    guard self.currentAuthentication(attempt) else { return }
                    self.endAuthentication(attempt)
                    self.tell("The account changed. Refresh before signing in.")
                }
            }
        }
    }
    private func currentAuthentication(_ attempt: UUID) -> Bool {
        signInPending && signInAttempt == attempt
    }
    private func randomProof() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { fatalError("Secure randomness unavailable") }
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func beginAuthentication(_ attempt: UUID, provider: String?) {
        let state = randomProof(), verifier = randomProof()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        var components = URLComponents(url: origin.appendingPathComponent("api/auth/desktop/start"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "challenge", value: challenge)]
        if let provider { components.queryItems?.append(URLQueryItem(name: "provider", value: provider)) }
        pendingDestination = webView.url
        let completion: (URL?, Error?) -> Void = { [weak self] callback, error in
            Task { @MainActor in
                guard let self, self.currentAuthentication(attempt), self.authenticationCallbackPending else { return }
                self.authenticationCallbackPending = false
                self.authentication = nil
                if let error {
                    self.endAuthentication(attempt)
                    let failure = error as NSError
                    if failure.domain == ASWebAuthenticationSessionErrorDomain && failure.code == ASWebAuthenticationSessionError.Code.canceledLogin.rawValue {
                        self.status.stringValue = "Sign-in cancelled. Your room is unchanged."
                    } else {
                        self.status.stringValue = "Browser sign-in could not finish."
                        self.tell("Browser sign-in couldn’t finish. Try again, or use email and password in this window.")
                    }
                    return
                }
                guard let callback, callback.scheme == "projectroom", callback.host == "auth", callback.path.isEmpty,
                      let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                      parts.queryItems?.filter({ $0.name == "state" }).count == 1,
                      parts.queryItems?.first(where: { $0.name == "state" })?.value == state else {
                    self.endAuthentication(attempt); self.tell("Sign-in did not match this app. Start again."); return
                }
                if parts.queryItems?.first(where: { $0.name == "error" })?.value == "access_denied" { self.endAuthentication(attempt); self.status.stringValue = "Sign-in cancelled."; return }
                guard parts.queryItems?.filter({ $0.name == "code" }).count == 1,
                      let code = parts.queryItems?.first(where: { $0.name == "code" })?.value,
                      code.count == 36 && code.hasPrefix("oac_") else { self.endAuthentication(attempt); self.tell("Sign-in did not finish. Start again."); return }
                await self.completeAuthentication(code: code, verifier: verifier, attempt: attempt)
            }
        }
        let session = acceptanceAuthenticationFactory?(components.url!, "projectroom", completion)
            ?? ASWebAuthenticationSession(url: components.url!, callbackURLScheme: "projectroom", completionHandler: completion)
        session.presentationContextProvider = self
        authentication = session
        authenticationCallbackPending = true
        if !session.start() { authentication = nil; endAuthentication(attempt); tell("The browser sign-in session could not open. Email and password sign-in are available in the window.") }
        else { status.stringValue = "Finish signing in in your browser…" }
    }
    private func endAuthentication(_ attempt: UUID) {
        guard currentAuthentication(attempt) else { return }
        signInPending = false; signInAttempt = nil; authenticationCallbackPending = false
        signInSlot = nil; pendingDestination = nil; authentication = nil; webView.isHidden = false
    }
    private func completeAuthentication(code: String, verifier: String, attempt: UUID) async {
        defer { endAuthentication(attempt) }
        var request = URLRequest(url: origin.appendingPathComponent("api/auth/desktop/session"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])
        // A fresh, ephemeral HTTP client carries no browser cookies. Only the
        // dedicated Room cookie is installed into WKWebView after redemption.
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        do {
            let (_, response) = try await session.data(for: request)
            guard currentAuthentication(attempt) else { return }
            guard let http = response as? HTTPURLResponse, http.statusCode == 201 else { tell("Sign-in expired or could not be confirmed. Start again."); return }
            let headers = http.allHeaderFields.reduce(into: [String: String]()) { result, entry in result[String(describing: entry.key)] = String(describing: entry.value) }
            let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: origin)
            guard let cookie = cookies.first(where: { $0.name == "account_session" || $0.name == "__Host-account_session" }), cookie.isHTTPOnly else { tell("Sign-in could not be installed securely. Start again."); return }
            let slot = try await webView.callAsyncJavaScript("const s = await (await fetch('/api/account-session')).json(); return s.authenticated ? null : JSON.stringify([s.sessionBinding,s.sessionRevision]);", arguments: [:], in: nil, contentWorld: .page)
            guard currentAuthentication(attempt) else { return }
            guard let tuple = slot as? String, tuple == signInSlot else { tell("The account changed while signing in. Your current session was kept."); return }
            await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
            status.stringValue = "Signed in"
            webView.isHidden = false
            // A new WK store has no browser account hint. Explicitly restore
            // the freshly installed session while retaining the original room,
            // invitation fragment and other destination parameters.
            var destination = URLComponents(url: pendingDestination ?? origin, resolvingAgainstBaseURL: false)
            var query = destination?.queryItems ?? []
            query.removeAll { $0.name == "oauth" }
            query.append(URLQueryItem(name: "oauth", value: "login"))
            destination?.queryItems = query
            open(destination?.url ?? origin)
            pendingDestination = nil
        } catch {
            guard currentAuthentication(attempt) else { return }
            tell("Couldn’t reach Project Room to finish sign-in. Start again when connected.")
        }
    }
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { window }
    @objc public func showMyMac() {
        do { if localTools == nil { localTools = try LocalToolsWindow() }; localTools?.show() }
        catch let failure as LocalToolFailure {
            tell(failure.code == "mac_tools_already_running" ? "Another Project Room instance owns this Mac connection. Use its My Mac window, or quit it and try again." : "Local tools could not open. Check that Project Room can write its Application Support folder, then try again.")
        } catch { tell("Local tools could not open. Try again after restarting Project Room.") }
    }
    public func stopLocalTools() { localTools?.stop() }
    private func tell(_ message: String) {
        status.stringValue = message
        let alert = NSAlert(); alert.messageText = "Project Room"; alert.informativeText = message; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // Blob exports retain their creator's security origin. Third-party
        // frames, data URLs, and ordinary blob navigation gain no capabilities.
        let source = navigationAction.sourceFrame.securityOrigin
        let expectedPort = origin.port ?? (origin.scheme == "https" ? 443 : 80)
        let sourcePort = source.port == 0 ? (source.protocol == "https" ? 443 : 80) : source.port
        if navigationAction.shouldPerformDownload, url.scheme == "blob",
           navigationAction.sourceFrame.isMainFrame,
           source.protocol == origin.scheme, source.host == origin.host, sourcePort == expectedPort,
           let creator = URL(string: String(url.absoluteString.dropFirst(5))), RoomLocation.sameOrigin(creator, origin) {
            decisionHandler(.download); return
        }
        if RoomLocation.sameOrigin(url, origin) {
            if url.path == "/api/auth/google/start" || url.path == "/api/auth/github/start" {
                decisionHandler(.cancel); signIn(provider: url.path == "/api/auth/google/start" ? "google" : "github"); return
            }
            decisionHandler(.allow); return
        }
        // Only a selected external link may open another app; redirects and
        // third-party frames cannot launch URLs or acquire native capabilities.
        if navigationAction.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    public func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if RoomLocation.sameOrigin(url, origin) { open(url) }
        else if navigationAction.navigationType == .linkActivated && ["https", "http", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }
    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(navigationResponse.canShowMIMEType && !disposition.lowercased().hasPrefix("attachment") ? .allow : .download)
    }
    public func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    public func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    public func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let filename = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        if let acceptanceDownloadDestination {
            completionHandler(acceptanceDownloadDestination(filename)); return
        }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = filename
        status.stringValue = "Choose where to save the download…"
        panel.beginSheetModal(for: window) { [weak self] result in
            if result != .OK { self?.cancelledDownloads.insert(ObjectIdentifier(download)) }
            self?.status.stringValue = result == .OK ? "Saving download…" : "Download cancelled"
            completionHandler(result == .OK ? panel.url : nil)
        }
    }
    public func downloadDidFinish(_ download: WKDownload) {
        completedDownloadCount += 1
        status.stringValue = "Download saved"
    }
    public func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        failedDownloadCount += 1
        let cancelled = cancelledDownloads.remove(ObjectIdentifier(download)) != nil || (error as NSError).code == NSURLErrorCancelled
        status.stringValue = cancelled ? "Download cancelled" : "Download did not finish · Try again"
    }
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { status.stringValue = origin.host ?? "Project Room" }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        status.stringValue = "Connection unavailable · Reload to retry"
    }
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { status.stringValue = "Room content stopped · Reload to recover saved text drafts" }
    public func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, let url = webView.url, RoomLocation.sameOrigin(url, origin) else { completionHandler(nil); return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    public func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "Project Room"; alert.informativeText = String(message.prefix(2000)); alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    public func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Project Room"; alert.informativeText = String(message.prefix(2000)); alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
}
