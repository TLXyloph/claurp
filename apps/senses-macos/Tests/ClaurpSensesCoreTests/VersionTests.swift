import XCTest
@testable import ClaurpSensesCore

final class VersionTests: XCTestCase {
    func testClientName() {
        XCTAssertEqual(ClaurpSenses.clientName, "senses-macos")
    }
}
