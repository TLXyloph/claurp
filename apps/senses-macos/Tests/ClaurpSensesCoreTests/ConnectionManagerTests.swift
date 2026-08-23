import XCTest
@testable import ClaurpSensesCore

final class MockTransport: WsTransport {
    var onEvent: ((WsTransportEvent) -> Void)?
    var connects: [URL] = []
    var sentTexts: [String] = []
    var sentData: [Data] = []
    var closeCount = 0
    func connect(url: URL) { connects.append(url) }
    func send(text: String) { sentTexts.append(text) }
    func send(data: Data) { sentData.append(data) }
    func close() { closeCount += 1 }
}

final class ConnectionManagerTests: XCTestCase {
    var transport: MockTransport!
    var retries: [(delay: TimeInterval, block: () -> Void)]!
    var manager: ConnectionManager!
    var states: [ConnectionState]!

    override func setUp() {
        super.setUp()
        transport = MockTransport()
        retries = []
        states = []
        manager = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: transport,
            backoff: Backoff(random: { _ in 1.0 }),
            scheduleRetry: { [self] delay, block in retries.append((delay, block)) })
        manager.onStateChange = { [self] in states.append($0) }
    }

    private func handshake() {
        manager.start()
        transport.onEvent?(.opened)
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
    }

    func testHelloIsTheFirstTextSentOnOpen() throws {
        manager.start()
        XCTAssertEqual(manager.state, .connecting)
        XCTAssertEqual(transport.connects, [URL(string: "ws://127.0.0.1:8765")!])
        transport.onEvent?(.opened)
        XCTAssertEqual(manager.state, .helloSent)
        let first = try XCTUnwrap(transport.sentTexts.first)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(first.utf8)) as? NSDictionary)
        XCTAssertEqual(obj, ["v": 1, "type": "hello", "client": "senses-macos", "protocol": 1])
    }

    func testHelloAckCompletesHandshake() {
        handshake()
        XCTAssertEqual(manager.state, .connected(daemonVersion: "0.1.0"))
        XCTAssertEqual(states.last, .connected(daemonVersion: "0.1.0"))
    }

    func testDaemonMessagesForwardAfterHandshake() {
        var received: [DaemonMessage] = []
        manager.onDaemonMessage = { received.append($0) }
        handshake()
        transport.onEvent?(.text(#"{"v":1,"type":"state","mode":"listening"}"#))
        XCTAssertEqual(received, [.state(mode: .listening)])
    }

    func testTtsBinaryFramesSurfaceAsPcm() {
        var pcm: [[Int16]] = []
        manager.onTtsPcm = { pcm.append($0) }
        handshake()
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [5, -5])))
        XCTAssertEqual(pcm, [[5, -5]])
        transport.onEvent?(.data(FrameCodec.encode(.micPcm16k, pcm: [1]))) // wrong direction
        transport.onEvent?(.data(Data([0x02, 0x01])))                      // malformed
        XCTAssertEqual(pcm.count, 1)
    }

    func testSendsDropUnlessConnected() {
        manager.start()
        transport.onEvent?(.opened)
        manager.sendMicFrame([1, 2, 3])
        manager.send(.ptt(action: .down))
        XCTAssertTrue(transport.sentData.isEmpty)
        XCTAssertEqual(transport.sentTexts.count, 1) // just the hello
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
        manager.sendMicFrame([1, 2, 3])
        XCTAssertEqual(transport.sentData.count, 1)
        XCTAssertEqual(transport.sentData[0].first, 0x01)
    }

    func testCloseSchedulesBackoffRetries() {
        handshake()
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(manager.state, .disconnected)
        XCTAssertEqual(retries.count, 1)
        XCTAssertEqual(retries[0].delay, 0.5)

        retries[0].block() // retry → connect again, fails immediately
        XCTAssertEqual(transport.connects.count, 2)
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(retries[1].delay, 1.0)
    }

    func testSuccessfulHandshakeResetsBackoff() {
        handshake()
        transport.onEvent?(.closed(reason: nil))     // delay 0.5
        retries[0].block()
        transport.onEvent?(.opened)
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(retries[1].delay, 0.5)        // reset, not 1.0
    }

    func testStopClosesWithoutRetry() {
        handshake()
        manager.stop()
        XCTAssertEqual(transport.closeCount, 1)
        transport.onEvent?(.closed(reason: nil))
        XCTAssertTrue(retries.isEmpty)
    }

    func testGarbageInboundIsDroppedSilently() {
        var received: [DaemonMessage] = []
        manager.onDaemonMessage = { received.append($0) }
        handshake()
        transport.onEvent?(.text("not json"))
        transport.onEvent?(.text(#"{"v":1,"type":"future.thing"}"#))
        XCTAssertTrue(received.isEmpty)
        XCTAssertEqual(manager.state, .connected(daemonVersion: "0.1.0"))
    }
}
