import AppKit
import AVFoundation
import ClaurpSensesCore

// Replaced by real implementations in Task 15.
final class NoopEarcons: EarconPlayerType {
    func play(_ kind: EarconKind) {}
}
final class NoopNotifier: NotificationPresenterType {
    func present(_ notify: NotifyPayload) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var controller: SensesController!
    private var statusItem: NSStatusItem!
    private var pauseItem: NSMenuItem!
    private var reconnectItem: NSMenuItem!
    private var micDeniedItem: NSMenuItem!
    private var paused = false
    private let hudStore = HudStore()
    private var pillPanel: PillPanel!
    private var offlineHideTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let connection = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: UrlSessionWsTransport(),
            scheduleRetry: { delay, block in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            })
        controller = SensesController(
            connection: connection,
            mic: MicCaptureEngine(),
            playback: TtsPlaybackController(scheduler: EnginePcmScheduler()),
            earcons: NoopEarcons(),
            notifier: NoopNotifier())

        setUpStatusItem()
        pillPanel = PillPanel(store: hudStore) { [weak self] card, decision in
            self?.controller.respond(sessionId: card.sessionId,
                                     requestId: card.requestId,
                                     decision: decision)
        }
        controller.onHudChange = { [weak self] hud in self?.hudChanged(hud) }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                self?.micDeniedItem.isHidden = granted
                self?.controller.start()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.quit()
    }

    /// Tasks 15–16 extend this (earcons, notifications).
    func hudChanged(_ hud: HudState) {
        statusItem.button?.image = StatusIcon.image(for: hud)
        reconnectItem.isHidden = !hud.offline
        hudStore.state = hud
        offlineHideTimer?.invalidate()
        switch hud.pill {
        case .hidden:
            pillPanel.orderOut(nil)
        case .offline:
            pillPanel.refreshSize()
            pillPanel.orderFrontRegardless()
            // Offline chip auto-hides; the status icon keeps the persistent signal.
            offlineHideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
                self?.pillPanel.orderOut(nil)
            }
        default:
            pillPanel.refreshSize()
            pillPanel.orderFrontRegardless()
        }
    }

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = StatusIcon.image(for: controller.hud)

        let menu = NSMenu()
        pauseItem = NSMenuItem(title: "Pause Listening",
                               action: #selector(togglePause), keyEquivalent: "")
        pauseItem.target = self
        menu.addItem(pauseItem)

        reconnectItem = NSMenuItem(title: "Reconnect Now",
                                   action: #selector(reconnect), keyEquivalent: "")
        reconnectItem.target = self
        menu.addItem(reconnectItem)

        micDeniedItem = NSMenuItem(title: "Microphone Access Denied — Open Settings…",
                                   action: #selector(openMicSettings), keyEquivalent: "")
        micDeniedItem.target = self
        micDeniedItem.isHidden = true
        menu.addItem(micDeniedItem)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit claurp", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc private func togglePause() {
        paused.toggle()
        controller.setPaused(paused)
        pauseItem.title = paused ? "Resume Listening" : "Pause Listening"
    }

    @objc private func reconnect() {
        controller.reconnectNow()
    }

    @objc private func openMicSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
        NSWorkspace.shared.open(url)
    }

    @objc private func quitApp() {
        controller.quit()
        NSApp.terminate(nil)
    }
}
