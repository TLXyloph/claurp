import XCTest
@testable import ClaurpSensesCore

final class PcmChunkerTests: XCTestCase {
    func testAccumulatesToExactChunks() {
        var c = PcmChunker() // 320 default
        let first = c.push([Int16](repeating: 1, count: 500))
        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(first[0].count, 320)

        let second = c.push([Int16](repeating: 2, count: 140)) // 180 + 140 = 320
        XCTAssertEqual(second.count, 1)
        XCTAssertEqual(second[0].count, 320)
        XCTAssertEqual(second[0][0], 1)   // remainder of the first push leads
        XCTAssertEqual(second[0][319], 2)
    }

    func testEmitsMultipleChunksAtOnce() {
        var c = PcmChunker(chunkSize: 4)
        XCTAssertEqual(c.push([1, 2, 3, 4, 5, 6, 7, 8, 9]).count, 2)
        XCTAssertEqual(c.push([10, 11, 12]), [[9, 10, 11, 12]])
    }

    func testResetDropsRemainder() {
        var c = PcmChunker(chunkSize: 4)
        XCTAssertEqual(c.push([1, 2, 3]), [])
        c.reset()
        XCTAssertEqual(c.push([4, 5, 6]), [])       // old 1,2,3 gone
        XCTAssertEqual(c.push([7]), [[4, 5, 6, 7]])
    }
}
