import Foundation

public enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case helloSent
    case connected(daemonVersion: String)
}

/// Hello-first handshake, ack gate, and backoff reconnect (spec §5).
/// Main-thread only; the transport must deliver events on main.
public final class ConnectionManager {
    private let url: URL
    private let transport: WsTransport
    private var backoff: Backoff
    private let scheduleRetry: (TimeInterval, @escaping () -> Void) -> Void
    private var stopped = false

    public private(set) var state: ConnectionState = .disconnected {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    public var onStateChange: ((ConnectionState) -> Void)?
    public var onDaemonMessage: ((DaemonMessage) -> Void)?
    public var onTtsPcm: (([Int16]) -> Void)?

    public init(url: URL,
                transport: WsTransport,
                backoff: Backoff = Backoff(),
                scheduleRetry: @escaping (TimeInterval, @escaping () -> Void) -> Void) {
        self.url = url
        self.transport = transport
        self.backoff = backoff
        self.scheduleRetry = scheduleRetry
        transport.onEvent = { [weak self] in self?.handle($0) }
    }

    public func start() {
        stopped = false
        connect()
    }

    public func stop() {
        stopped = true
        transport.close()
        state = .disconnected
    }

    public func reconnectNow() {
        guard state == .disconnected, !stopped else { return }
        backoff.reset()
        connect()
    }

    public func send(_ msg: SensesMessage) {
        guard case .connected = state, let data = try? WireCodec.encode(msg),
              let text = String(data: data, encoding: .utf8) else { return }
        transport.send(text: text)
    }

    public func sendMicFrame(_ pcm: [Int16]) {
        guard case .connected = state else { return }
        transport.send(data: FrameCodec.encode(.micPcm16k, pcm: pcm))
    }

    private func connect() {
        state = .connecting
        transport.connect(url: url)
    }

    private func handle(_ event: WsTransportEvent) {
        switch event {
        case .opened:
            if let data = try? WireCodec.encode(.hello(client: ClaurpSenses.clientName)),
               let text = String(data: data, encoding: .utf8) {
                transport.send(text: text)
            }
            state = .helloSent

        case .text(let text):
            let result: DaemonMessage?
            do {
                result = try WireCodec.decodeDaemon(Data(text.utf8))
            } catch {
                NSLog("claurp: dropping malformed daemon message")
                return
            }
            guard let msg = result else {
                NSLog("claurp: dropping unknown daemon message")
                return
            }
            if case .helloSent = state {
                if case .helloAck(let version) = msg {
                    backoff.reset()
                    state = .connected(daemonVersion: version)
                }
                return // nothing else is expected before the ack
            }
            if case .connected = state {
                onDaemonMessage?(msg)
            }

        case .data(let data):
            guard case .connected = state,
                  let frame = try? FrameCodec.decode(data),
                  frame.type == BinaryFrameType.ttsPcm24k.rawValue else { return }
            onTtsPcm?(frame.pcm)

        case .closed(let reason):
            let wasStopped = stopped
            state = .disconnected
            if !wasStopped {
                let delay = backoff.next()
                NSLog("claurp: daemon connection closed (%@); retrying in %.1fs",
                      reason ?? "no reason", delay)
                scheduleRetry(delay) { [weak self] in
                    guard let self, !self.stopped, self.state == .disconnected else { return }
                    self.connect()
                }
            }
        }
    }
}
