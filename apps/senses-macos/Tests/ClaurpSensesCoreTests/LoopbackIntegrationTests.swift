import XCTest
import Network
@testable import ClaurpSensesCore

/// In-process WebSocket server (Network.framework). Pings the client so the
/// test proves the real transport survives the daemon's watchdog pattern.
final class StubWsServer {
    private let listener: NWListener
    private var connection: NWConnection?
    private(set) var receivedBinary: [Data] = []
    var onText: ((String) -> Void)?
    var onBinary: ((Data) -> Void)?
    // Default-initialized so the handler closures below may capture self
    // (all stored properties must be set before self is captured).
    private(set) var port: UInt16 = 0
    // Dedicated queue: the test thread blocks on the ready semaphore, so
    // listener callbacks must NOT be scheduled on .main or init deadlocks.
    private let queue = DispatchQueue(label: "claurp.stub-ws-server")

    init() throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        listener = try NWListener(using: params, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = self?.listener.port?.rawValue ?? 0
                ready.signal()
            }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            self.connection = conn
            conn.start(queue: self.queue)
            self.receiveNext(on: conn)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, port != 0 else {
            throw XCTSkip("sandbox refused a loopback listener")
        }
    }

    private func receiveNext(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            if let data, let context,
               let meta = context.protocolMetadata(definition: NWProtocolWebSocket.definition)
                            as? NWProtocolWebSocket.Metadata {
                switch meta.opcode {
                case .text:
                    self.onText?(String(decoding: data, as: UTF8.self))
                case .binary:
                    self.receivedBinary.append(data)
                    self.onBinary?(data)
                default:
                    break
                }
            }
            self.receiveNext(on: conn)
        }
    }

    private func sendFrame(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
        let meta = NWProtocolWebSocket.Metadata(opcode: opcode)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
        connection?.send(content: data, contentContext: context,
                         isComplete: true, completion: .contentProcessed { _ in })
    }

    func send(text: String) { sendFrame(Data(text.utf8), opcode: .text) }
    func send(binary: Data) { sendFrame(binary, opcode: .binary) }
    func ping() { sendFrame(Data(), opcode: .ping) }
    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}

final class LoopbackIntegrationTests: XCTestCase {
    func testHandshakeFramesAndWatchdogSurvival() throws {
        let server = try StubWsServer()
        defer { server.stop() }

        let helloReceived = expectation(description: "server got hello")
        var helloWasFirst = false
        var textCount = 0
        server.onText = { text in
            textCount += 1
            if textCount == 1, text.contains("\"type\":\"hello\"") || text.contains("\"hello\"") {
                helloWasFirst = true
                server.send(text: #"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#)
                helloReceived.fulfill()
            }
        }

        let manager = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:\(server.port)")!,
            transport: UrlSessionWsTransport(),
            scheduleRetry: { delay, block in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            })
        let connected = expectation(description: "connected")
        var sawDisconnect = false
        manager.onStateChange = { state in
            if case .connected = state { connected.fulfill() }
            if state == .disconnected { sawDisconnect = true }
        }
        var ttsPcm: [[Int16]] = []
        let gotTts = expectation(description: "tts frame")
        manager.onTtsPcm = { pcm in
            ttsPcm.append(pcm)
            gotTts.fulfill()
        }
        manager.start()
        wait(for: [helloReceived, connected], timeout: 5)
        XCTAssertTrue(helloWasFirst)

        // Binary both directions.
        server.send(binary: FrameCodec.encode(.ttsPcm24k, pcm: [9, -9]))
        wait(for: [gotTts], timeout: 5)
        XCTAssertEqual(ttsPcm, [[9, -9]])

        let gotMic = expectation(description: "mic frame")
        server.onBinary = { data in
            if data.first == 0x01 { gotMic.fulfill() }
        }
        manager.sendMicFrame([1, 2, 3])
        wait(for: [gotMic], timeout: 5)

        // Watchdog pattern: several server pings; connection must stay up
        // (URLSession auto-pongs) and traffic must still flow afterwards.
        for i in 0..<3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.3) { server.ping() }
        }
        let stillAlive = expectation(description: "message after pings")
        var sawPostPingState = false
        manager.onDaemonMessage = { msg in
            if msg == .state(mode: .listening), !sawPostPingState {
                sawPostPingState = true
                stillAlive.fulfill()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            server.send(text: #"{"v":1,"type":"state","mode":"listening"}"#)
        }
        wait(for: [stillAlive], timeout: 5)
        XCTAssertFalse(sawDisconnect)
        manager.stop()
    }
}
