import XCTest
@testable import ClaurpSensesCore

final class BackoffTests: XCTestCase {
    func testDoublesToCapWithoutJitter() {
        var b = Backoff(random: { _ in 1.0 })
        XCTAssertEqual([b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()],
                       [0.5, 1, 2, 4, 8, 10, 10])
    }

    func testResetRestartsSequence() {
        var b = Backoff(random: { _ in 1.0 })
        _ = b.next(); _ = b.next()
        b.reset()
        XCTAssertEqual(b.next(), 0.5)
    }

    func testJitterMultipliesTheDelay() {
        var b = Backoff(random: { range in range.upperBound })
        XCTAssertEqual(b.next(), 0.5 * 1.2, accuracy: 0.0001)
    }
}
