import AppKit
import AVFoundation
import SwiftUI
import ClaurpSensesCore

final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var controller: SensesController!
    private var statusItem: NSStatusItem!
    private var pauseItem: NSMenuItem!
    private var reconnectItem: NSMenuItem!
    private var micDeniedItem: NSMenuItem!
    private var micMenu: NSMenu!
    private var paused = false
    private var micDenied = false
    private let hudStore = HudStore()
    private let micLevelStore = MicLevelStore()
    private let micTestRecorder = MicTestRecorder()
    private var micTestWindowController: NSWindowController?
    private var notchPanel: NotchPanel!
    private var offlineHideTimer: Timer?
    private let pttHotKey = PttHotKey()
    private var micEngine: MicCaptureEngine!
    // HudState() starts offline == true; mirror that so the first real
    // transition (offline -> online) is the one that gets logged.
    private var wasOffline = true

    func applicationDidFinishLaunching(_ notification: Notification) {
        let connection = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: UrlSessionWsTransport(),
            scheduleRetry: { delay, block in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            })
        let notifier = NotificationPresenter()
        notifier.setUp()

        let mic = MicCaptureEngine()
        micEngine = mic
        mic.onTapStats = { tapRms, tapFrames, chunksEmitted in
            DebugAudioLog.log(String(format: "tap rms=%.4f frames=%d chunks=%d",
                                     tapRms, tapFrames, chunksEmitted))
        }

        controller = SensesController(
            connection: connection,
            mic: mic,
            playback: TtsPlaybackController(scheduler: EnginePcmScheduler()),
            earcons: EarconPlayer(),
            notifier: notifier)

        controller.onMicLevel = { [weak self] level in self?.micLevelStore.level = level }
        controller.onMicChunkTap = { [weak self] chunk in self?.micTestRecorder.receive(chunk) }

        pttHotKey.onDown = { [weak self] in self?.controller.pttDown() }
        pttHotKey.onUp = { [weak self] in self?.controller.pttUp() }
        pttHotKey.register()

        notifier.onDecision = { [weak self] sessionId, requestId, decision in
            DispatchQueue.main.async {
                self?.controller.respond(sessionId: sessionId,
                                         requestId: requestId,
                                         decision: decision)
            }
        }

        setUpStatusItem()
        notchPanel = NotchPanel(store: hudStore, levelStore: micLevelStore) { [weak self] card, decision in
            self?.controller.respond(sessionId: card.sessionId,
                                     requestId: card.requestId,
                                     decision: decision)
        }
        controller.onHudChange = { [weak self] hud in self?.hudChanged(hud) }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                self.micDeniedItem.isHidden = granted
                self.micDenied = !granted
                self.statusItem.button?.image = StatusIcon.image(for: self.controller.hud, micDenied: self.micDenied)
                self.controller.start()
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self else { return }
                    DebugAudioLog.log("start: \(self.micEngine.lastStartDescription)")
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.quit()
    }

    /// Tasks 15–16 extend this (earcons, notifications).
    func hudChanged(_ hud: HudState) {
        statusItem.button?.image = StatusIcon.image(for: hud, micDenied: micDenied)
        reconnectItem.isHidden = !hud.offline
        if hud.offline != wasOffline {
            wasOffline = hud.offline
            DebugAudioLog.log("connection: offline=\(hud.offline)")
        }
        hudStore.state = hud
        offlineHideTimer?.invalidate()
        switch hud.pill {
        case .hidden:
            notchPanel.hide()
        case .offline:
            notchPanel.show()
            // Offline chip auto-hides; the status icon keeps the persistent signal.
            offlineHideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
                self?.notchPanel.hide()
            }
        default:
            notchPanel.show()
        }
    }

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = StatusIcon.image(for: controller.hud, micDenied: micDenied)

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

        let micMenuItem = NSMenuItem(title: "Microphone", action: nil, keyEquivalent: "")
        micMenu = NSMenu(title: "Microphone")
        micMenu.delegate = self
        micMenuItem.submenu = micMenu
        menu.addItem(micMenuItem)

        let testMicItem = NSMenuItem(title: "Test Microphone…",
                                     action: #selector(openMicTester), keyEquivalent: "")
        testMicItem.target = self
        menu.addItem(testMicItem)

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

    @objc private func selectMicMenuItem(_ sender: NSMenuItem) {
        selectMicrophone(uid: sender.representedObject as? String)
    }

    /// Sets/clears `claurpInputDeviceUID` and restarts capture so the new
    /// device takes effect immediately, mirroring `MicCaptureEngine.start()`'s
    /// device-selection order (spec: override UID first, else built-in pin).
    /// If listening is currently paused, only the preference is updated —
    /// the new device is picked up next time the mic actually starts.
    private func selectMicrophone(uid: String?) {
        if let uid {
            UserDefaults.standard.set(uid, forKey: "claurpInputDeviceUID")
        } else {
            UserDefaults.standard.removeObject(forKey: "claurpInputDeviceUID")
        }
        guard !paused else { return }
        micEngine.stop()
        do {
            try micEngine.start()
            DebugAudioLog.log("mic switch: \(self.micEngine.lastStartDescription)")
        } catch {
            NSLog("claurp: mic restart after device switch failed: %@", error.localizedDescription)
        }
    }

    @objc private func openMicTester() {
        NSApp.activate(ignoringOtherApps: true)
        if let existing = micTestWindowController {
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        let view = MicTesterView(levelStore: micLevelStore, recorder: micTestRecorder) { [weak self] in
            self?.micEngine.lastStartDescription ?? "unknown"
        }
        let hosting = NSHostingController(rootView: view)
        let window = NSWindow(contentViewController: hosting)
        window.title = "Test Microphone"
        window.styleMask = [.titled, .closable]
        window.isReleasedWhenClosed = false
        let windowController = NSWindowController(window: window)
        micTestWindowController = windowController
        windowController.showWindow(nil)
    }
}

extension AppDelegate: NSMenuDelegate {
    /// Rebuilds the "Microphone" submenu each time it opens, so the device
    /// list and checkmark always reflect current hardware and the current
    /// `claurpInputDeviceUID` selection.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === micMenu else { return }
        menu.removeAllItems()
        let currentUID = UserDefaults.standard.string(forKey: "claurpInputDeviceUID")

        let defaultItem = NSMenuItem(title: "Built-in (default)",
                                     action: #selector(selectMicMenuItem(_:)), keyEquivalent: "")
        defaultItem.target = self
        defaultItem.state = currentUID == nil ? .on : .off
        menu.addItem(defaultItem)
        menu.addItem(.separator())

        for device in AudioInputDevice.allInputDevices() {
            let item = NSMenuItem(title: device.name,
                                  action: #selector(selectMicMenuItem(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = device.uid
            item.state = (currentUID == device.uid) ? .on : .off
            menu.addItem(item)
        }
    }
}
