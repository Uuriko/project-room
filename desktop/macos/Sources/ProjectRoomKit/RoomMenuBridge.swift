import AppKit
import WebKit

@MainActor extension RoomWindow {
    /// No credentials leave WebKit. Native actions use the existing authenticated UI.
    func menuSnapshot() async throws -> [String: Any] {
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return [:] }
        let value = try await webView.evaluateJavaScript("""
        (() => {
          const q = s => document.querySelector(s), visible = e => !!e && !e.closest('[hidden]') && !!e.getClientRects().length;
          const input = q('#message-input');
          if (!visible(input)) return {destination:'Open a room',context:'',ready:false,attention:null,runs:[]};
          const count = s => { const e=q(s); return visible(e) && /^\\d+$/.test(e.textContent.trim()) ? Number(e.textContent.trim()) : null; };
          return { destination: [q('#room-title')?.textContent, input?.placeholder, q('#message-to-select')?.selectedOptions[0]?.textContent].filter(Boolean).join(' · '),
            context: JSON.stringify([location.href, q('#message-to-select')?.value, q('#message-input')?.placeholder, q('#composer-label')?.textContent, q('#reply-preview')?.textContent]),
            ready: visible(input) && !input.disabled,
            attention: count('#activity-preview-count') ?? count('#attention-count'),
            attentionError: q('#attention-status')?.textContent || '',
            runs: [...document.querySelectorAll('[data-assistant-run]')].filter(e=>e.querySelector('[data-cancel=true]')).slice(0,20).map(e=>({id:e.dataset.assistantRun, title:e.querySelector('strong')?.textContent || 'Room task', status:e.querySelector('p')?.textContent || '', revision:e.querySelector('[data-cancel=true]')?.dataset.revision || ''})) };
        })()
        """)
        return value as? [String: Any] ?? [:]
    }
    func menuPrompt(_ text: String, context: String) async throws -> String {
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return "Open a room first." }
        let result = try await webView.callAsyncJavaScript("""
        const q = s => document.querySelector(s), input = q('#message-input'), form=q('#message-form');
        if (JSON.stringify([location.href, q('#message-to-select')?.value, q('#message-input')?.placeholder, q('#composer-label')?.textContent, q('#reply-preview')?.textContent]) !== context) return 'Room changed. Review the destination and try again.';
        if (!input || !form || input.disabled || !input.getClientRects().length) return 'Open a room and sign in first.';
        if (input.value.trim() || q('#composer-attachments')?.children.length) return 'Your room has a draft. Finish it before sending here.';
        const send = form.querySelector('[type=submit]');
        if (!send || send.disabled) return 'The composer is busy. Try again.';
        input.value = text; input.dispatchEvent(new Event('input', {bubbles:true}));
        const ask = q('#ask-room');
        if (ask && !ask.disabled && ask.getAttribute('aria-pressed') !== 'true') ask.click();
        form.requestSubmit(send);
        return '';
        """, arguments: ["text":text,"context":context], in:nil, contentWorld:.page)
        return result as? String ?? "Open the room to continue."
    }
    func menuStopRun(_ id: String, revision: String, context: String) async throws -> Bool {
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return false }
        let result = try await webView.callAsyncJavaScript("""
        const q = s => document.querySelector(s);
        if (JSON.stringify([location.href, q('#message-to-select')?.value, q('#message-input')?.placeholder, q('#composer-label')?.textContent, q('#reply-preview')?.textContent]) !== context) return false;
        const button = [...document.querySelectorAll('[data-assistant-run] [data-cancel=true]')].find(e=>e.dataset.pauseRun===id && e.dataset.revision===revision);
        if (!button || button.disabled) return false;
        button.click(); return true;
        """,arguments:["id":id,"revision":revision,"context":context],in:nil,contentWorld:.page)
        return result as? Bool == true
    }
    func menuAttention() {
        show()
        guard let url = webView.url, RoomLocation.sameOrigin(url, origin) else { return }
        webView.evaluateJavaScript("document.querySelector('#activity-preview-open')?.click(); document.querySelector('#needs-attention:not([hidden])')?.scrollIntoView({block:'center'})", completionHandler:nil)
    }
}
