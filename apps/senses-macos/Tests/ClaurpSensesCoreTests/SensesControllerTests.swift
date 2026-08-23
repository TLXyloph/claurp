import XCTest
@testable import ClaurpSensesCore

final class MockMic: MicCaptureType {
    var onChunk: (([Int16]) -> Void)?
    var isRunning = false
    var startCount = 0
    var stopCount = 0
    func start() throws { isRunning = true; startCount += 1 }
    func stop() { isRunning = false; stopCount += 1 }
}

final class MockEarcons: EarconPlayerType {
    var played: [EarconKind] = []
    var onPlay: ((EarconKind) -> Void)? // callback for ordering tests
    func play(_ kind: EarconKind) {
        played.append(kind)
        onPlay?(kind)
    }
}

final class MockNotifier: NotificationPresenterType {
    var presented: [NotifyPayload] = []
    func present(_ notify: NotifyPayload) { presented.append(notify) }
}

/// Wrapper around MockScheduler that logs flush events to a shared event log
/// for verifying the wake-ack ordering invariant (barge-in before play).
final class LoggingScheduler: PcmScheduler {
    private let inner: MockScheduler
    private let onFlush: () -> Void

    init(inner: MockScheduler, onFlush: @escaping () -> Void) {
        self.inner = inner
        self.onFlush = onFlush
    }

    func schedule(_ pcm: [Int16]) { inner.schedule(pcm) }
    func startPlayback() { inner.startPlayback() }
    func stopAndFlush() {
        inner.stopAndFlush()
        onFlush()
    }

    // For test assertions on the underlying scheduler
    var started: Int { inner.started }
    var flushed: Int { inner.flushed }
}

final class SensesControllerTests: XCTestCase {
    var transport: MockTransport!
    var mic: MockMic!
    var innerScheduler: MockScheduler!
    var loggingScheduler: LoggingScheduler!
    var earcons: MockEarcons!
    var notifier: MockNotifier!
    var controller: SensesController!
    var eventLog: [String] = []

    override func setUp() {
        super.setUp()
        transport = MockTransport()
        mic = MockMic()
        innerScheduler = MockScheduler()
        earcons = MockEarcons()
        notifier = MockNotifier()
        eventLog = []
        loggingScheduler = LoggingScheduler(inner: innerScheduler) { [weak self] in
            self?.eventLog.append("bargeIn()")
        }
        earcons.onPlay = { [self] kind in
            self.eventLog.append("play(\(kind.rawValue))")
        }

        let connection = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: transport,
            backoff: Backoff(random: { _ in 1.0 }),
            scheduleRetry: { _, _ in })
        controller = SensesController(
            connection: connection,
            mic: mic,
            playback: TtsPlaybackController(scheduler: loggingScheduler, prerollSamples: 100),
            earcons: earcons,
            notifier: notifier)
        controller.start()
        transport.onEvent?(.opened)
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
    }

    private func daemon(_ json: String) { transport.onEvent?(.text(json)) }

    func testStartConnectsAndStartsMic() {
        XCTAssertEqual(transport.connects.count, 1)
        XCTAssertEqual(mic.startCount, 1)
        XCTAssertFalse(controller.hud.offline)
    }

    func testMicChunksFlowToTransportAsBinary() {
        mic.onChunk?([1, 2, 3])
        XCTAssertEqual(transport.sentData.count, 1)
        XCTAssertEqual(transport.sentData[0].first, 0x01)
    }

    func testSpeakStopBargesIn() {
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        XCTAssertEqual(loggingScheduler.started, 1)
        daemon(#"{"v":1,"type":"speak.stop"}"#)
        XCTAssertEqual(loggingScheduler.flushed, 1)
    }

    func testWakeAckEarconBargesInAndPlays() {
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        daemon(#"{"v":1,"type":"earcon","kind":"wake-ack"}"#)
        XCTAssertEqual(loggingScheduler.flushed, 1)
        XCTAssertEqual(earcons.played, [.wakeAck])
        // Verify ordering invariant: bargeIn() must happen before play()
        XCTAssertEqual(eventLog, ["bargeIn()", "play(wake-ack)"],
                       "wake-ack barge-in must occur strictly before play (spec §3.2)")
    }

    func testNonWakeEarconPlaysWithoutBargeIn() {
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        daemon(#"{"v":1,"type":"earcon","kind":"done"}"#)
        XCTAssertEqual(loggingScheduler.flushed, 0)
        XCTAssertEqual(earcons.played, [.done])
    }

    func testNotifyIsPresented() {
        daemon(#"{"v":1,"type":"notify","title":"t","body":"b"}"#)
        XCTAssertEqual(notifier.presented.count, 1)
        XCTAssertEqual(notifier.presented[0].title, "t")
    }

    func testHudChangesPropagate() {
        var pills: [HudState.Pill] = []
        controller.onHudChange = { pills.append($0.pill) }
        daemon(#"{"v":1,"type":"state","mode":"listening"}"#)
        daemon(#"{"v":1,"type":"transcript.partial","text":"hey"}"#)
        XCTAssertEqual(pills.last, .listening(transcript: "hey"))
    }

    func testRespondSendsAndClearsCard() {
        daemon(#"{"v":1,"type":"state","mode":"needs-you"}"#)
        daemon(#"{"v":1,"type":"hud.permission","sessionId":"s-1","requestId":"r-1","tool":"Bash","detail":"d","spoken":"s"}"#)
        XCTAssertNotNil(controller.hud.permission)
        controller.respond(sessionId: "s-1", requestId: "r-1", decision: .allow)
        XCTAssertNil(controller.hud.permission)
        let sent = transport.sentTexts.last ?? ""
        XCTAssertTrue(sent.contains("permission.response"))
        XCTAssertTrue(sent.contains("\"decision\":\"allow\""))
    }

    func testPauseStopsMicAndResumeRestarts() {
        controller.setPaused(true)
        XCTAssertEqual(mic.stopCount, 1)
        XCTAssertTrue(controller.hud.paused)
        mic.onChunk?([1, 2, 3]) // engine would not emit while stopped; belt-and-braces
        controller.setPaused(false)
        XCTAssertEqual(mic.startCount, 2)
        XCTAssertFalse(controller.hud.paused)
    }

    func testMicChunkEmitsOnMicLevel() {
        var levels: [Float] = []
        controller.onMicLevel = { levels.append($0) }
        mic.onChunk?([Int16](repeating: 16384, count: 320))
        XCTAssertEqual(levels.last ?? -1, 0.5, accuracy: 0.01)
    }

    func testPttSendsDownAndUp() {
        controller.pttDown()
        controller.pttUp()
        XCTAssertTrue(transport.sentTexts.contains { $0.contains("\"action\":\"down\"") })
        XCTAssertTrue(transport.sentTexts.contains { $0.contains("\"action\":\"up\"") })
    }

    func testQuitStopsMicFlushesAndClosesConnection() {
        // Pre-condition: buffer some audio to play
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        XCTAssertEqual(mic.startCount, 1)
        XCTAssertTrue(mic.isRunning)

        // Invoke quit
        controller.quit()

        // Verify mic stopped
        XCTAssertEqual(mic.stopCount, 1)
        XCTAssertFalse(mic.isRunning)

        // Verify playback flushed (barge-in called)
        XCTAssertEqual(loggingScheduler.flushed, 1)

        // Verify connection closed
        XCTAssertEqual(transport.closeCount, 1)
    }
}
