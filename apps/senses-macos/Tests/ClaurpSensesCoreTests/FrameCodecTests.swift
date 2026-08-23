import XCTest
@testable import ClaurpSensesCore

final class FrameCodecTests: XCTestCase {
    func testEncodeMicFrameLittleEndian() {
        let data = FrameCodec.encode(.micPcm16k, pcm: [0, 1, -1, 32767, -32768])
        XCTAssertEqual([UInt8](data),
            [0x01, 0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF, 0xFF, 0x7F, 0x00, 0x80])
    }

    func testRoundTrip() throws {
        let pcm: [Int16] = [12345, -12345, 256, -1]
        let decoded = try FrameCodec.decode(FrameCodec.encode(.ttsPcm24k, pcm: pcm))
        XCTAssertEqual(decoded.type, 0x02)
        XCTAssertEqual(decoded.pcm, pcm)
    }

    func testEmptyFrameThrows() {
        XCTAssertThrowsError(try FrameCodec.decode(Data()))
    }

    func testOddPayloadThrows() {
        XCTAssertThrowsError(try FrameCodec.decode(Data([0x01, 0x00])))
    }

    func testUnknownTypeByteDecodesAndPassesThrough() throws {
        let decoded = try FrameCodec.decode(Data([0x7F, 0x00, 0x00]))
        XCTAssertEqual(decoded.type, 0x7F)
        XCTAssertEqual(decoded.pcm, [0])
    }

    func testDecodeSurvivesDataSlices() throws {
        // Data slices keep their parent's indices; decode must use startIndex-relative access.
        let full = Data([0xAA]) + FrameCodec.encode(.micPcm16k, pcm: [7, -7])
        let slice = full.dropFirst()
        let decoded = try FrameCodec.decode(slice)
        XCTAssertEqual(decoded.pcm, [7, -7])
    }
}
