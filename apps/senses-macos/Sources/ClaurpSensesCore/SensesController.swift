import Foundation

public protocol EarconPlayerType: AnyObject {
    func play(_ kind: EarconKind)
}

public protocol NotificationPresenterType: AnyObject {
    func present(_ notify: NotifyPayload)
}

/// Wires connection ↔ audio ↔ HUD. Main-thread only.
public final class SensesController {
    private let connection: ConnectionManager
    private let mic: MicCaptureType
    private let playback: TtsPlaybackController
    private let earcons: EarconPlayerType
    private let notifier: NotificationPresenterType

    public private(set) var hud = HudState()
    public var onHudChange: ((HudState) -> Void)?

    public init(connection: ConnectionManager,
                mic: MicCaptureType,
                playback: TtsPlaybackController,
                earcons: EarconPlayerType,
                notifier: NotificationPresenterType) {
        self.connection = connection
        self.mic = mic
        self.playback = playback
        self.earcons = earcons
        self.notifier = notifier
    }

    public func start() {
        connection.onStateChange = { [weak self] state in
            self?.dispatch(.connection(state))
        }
        connection.onDaemonMessage = { [weak self] msg in
            self?.handle(msg)
        }
        connection.onTtsPcm = { [weak self] pcm in
            self?.playback.receive(pcm)
        }
        mic.onChunk = { [weak self] chunk in
            self?.connection.sendMicFrame(chunk)
        }
        connection.start()
        startMicIfNeeded()
    }

    public func setPaused(_ paused: Bool) {
        if paused {
            mic.stop()
        } else {
            startMicIfNeeded()
        }
        dispatch(.pause(paused))
    }

    public func pttDown() { connection.send(.ptt(action: .down)) }
    public func pttUp() { connection.send(.ptt(action: .up)) }

    public func respond(sessionId: String, requestId: String, decision: PermissionDecision) {
        connection.send(.permissionResponse(sessionId: sessionId,
                                            requestId: requestId,
                                            decision: decision))
        dispatch(.permissionResolved)
    }

    public func reconnectNow() { connection.reconnectNow() }

    public func quit() {
        mic.stop()
        playback.bargeIn()
        connection.stop()
    }

    private func startMicIfNeeded() {
        guard !mic.isRunning else { return }
        do {
            try mic.start()
        } catch {
            NSLog("claurp: mic start failed: %@", error.localizedDescription)
        }
    }

    private func handle(_ msg: DaemonMessage) {
        switch msg {
        case .speakStop:
            playback.bargeIn()
        case .earcon(let kind):
            if kind == .wakeAck {
                playback.bargeIn() // never talk over the user (spec §3.2)
            }
            earcons.play(kind)
        case .notify(let payload):
            notifier.present(payload)
        default:
            break
        }
        dispatch(.daemon(msg))
    }

    private func dispatch(_ event: HudEvent) {
        let next = HudReducer.reduce(hud, event)
        guard next != hud else { return }
        hud = next
        onHudChange?(next)
    }
}
