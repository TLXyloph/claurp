import XCTest
@testable import ClaurpSensesCore

final class PcmLevelTests: XCTestCase {
    func testFullScaleSquareWaveIsApproximatelyOne() {
        var samples: [Int16] = []
        for i in 0..<320 {
            samples.append(i % 2 == 0 ? 32767 : -32767)
        }
        XCTAssertEqual(PcmLevel.rms(samples), 1.0, accuracy: 0.01)
    }

    func testHalfAmplitudeSineIsApproximatelyOneOverSqrtTwoHalved() {
        var samples: [Int16] = []
        for i in 0..<1600 {
            let value = sin(Double(i) * 2 * Double.pi / 100.0) * 16384.0
            samples.append(Int16(value.rounded()))
        }
        // RMS of a sine of amplitude A is A/sqrt(2); normalized by 32768:
        // (16384/sqrt(2)) / 32768 ≈ 0.3535
        XCTAssertEqual(PcmLevel.rms(samples), 0.3535, accuracy: 0.01)
    }

    func testSilenceIsZero() {
        let samples = [Int16](repeating: 0, count: 320)
        XCTAssertEqual(PcmLevel.rms(samples), 0.0, accuracy: 0.0001)
    }

    func testEmptyIsZero() {
        XCTAssertEqual(PcmLevel.rms([]), 0.0, accuracy: 0.0001)
    }
}
