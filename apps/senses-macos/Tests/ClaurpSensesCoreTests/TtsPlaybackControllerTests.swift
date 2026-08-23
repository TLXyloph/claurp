import XCTest
@testable import ClaurpSensesCore

final class MockScheduler: PcmScheduler {
    var scheduled: [[Int16]] = []
    var started = 0
    var flushed = 0
    func schedule(_ pcm: [Int16]) { scheduled.append(pcm) }
    func startPlayback() { started += 1 }
    func stopAndFlush() { flushed += 1 }
}

final class TtsPlaybackControllerTests: XCTestCase {
    func testDoesNotStartBeforePreroll() {
        let mock = MockScheduler()
        let c = TtsPlaybackController(scheduler: mock, prerollSamples: 2400)
        c.receive([Int16](repeating: 0, count: 1000))
        XCTAssertEqual(mock.scheduled.count, 1) // scheduled eagerly
        XCTAssertEqual(mock.started, 0)
        XCTAssertFalse(c.isPlaying)
    }

    func testStartsOnceAfterPreroll() {
        let mock = MockScheduler()
        let c = TtsPlaybackController(scheduler: mock, prerollSamples: 2400)
        c.receive([Int16](repeating: 0, count: 1000))
        c.receive([Int16](repeating: 0, count: 1500)) // 2500 total → start
        c.receive([Int16](repeating: 0, count: 1000)) // must not start again
        XCTAssertEqual(mock.started, 1)
        XCTAssertTrue(c.isPlaying)
    }

    func testBargeInStopsFlushesAndRearmsPreroll() {
        let mock = MockScheduler()
        let c = TtsPlaybackController(scheduler: mock, prerollSamples: 2400)
        c.receive([Int16](repeating: 0, count: 3000))
        c.bargeIn()
        XCTAssertEqual(mock.flushed, 1)
        XCTAssertFalse(c.isPlaying)
        c.receive([Int16](repeating: 0, count: 1000)) // below preroll again
        XCTAssertEqual(mock.started, 1)               // still just the first start
        c.receive([Int16](repeating: 0, count: 1500))
        XCTAssertEqual(mock.started, 2)
    }

    func testBargeInWithNothingBufferedIsNoOp() {
        let mock = MockScheduler()
        let c = TtsPlaybackController(scheduler: mock, prerollSamples: 2400)
        c.bargeIn()
        XCTAssertEqual(mock.flushed, 0)
    }

    func testEmptyFrameIsIgnored() {
        let mock = MockScheduler()
        let c = TtsPlaybackController(scheduler: mock, prerollSamples: 2400)
        c.receive([])
        XCTAssertEqual(mock.scheduled.count, 0)
    }
}
