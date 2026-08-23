import XCTest
@testable import ClaurpSensesCore

final class WireCodecTests: XCTestCase {
    private func decode(_ json: String) throws -> DaemonMessage? {
        try WireCodec.decodeDaemon(Data(json.utf8))
    }
    private func dict(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    // ---- decoding daemon → senses ----

    func testDecodeState() throws {
        XCTAssertEqual(try decode(#"{"v":1,"type":"state","mode":"needs-you"}"#),
                       .state(mode: .needsYou))
    }

    func testDecodeHelloAck() throws {
        XCTAssertEqual(try decode(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#),
                       .helloAck(daemonVersion: "0.1.0"))
    }

    func testDecodeHudSessionWithOptionalNarrationAbsent() throws {
        let json = #"{"v":1,"type":"hud.session","sessionId":"s-1","label":"notes app","state":"done","permissionMode":"default"}"#
        XCTAssertEqual(try decode(json), .hudSession(HudSession(
            sessionId: "s-1", label: "notes app", state: .done,
            permissionMode: .standard, narration: nil)))
    }

    func testDecodeNotifyDefaultsActionsToEmpty() throws {
        let json = #"{"v":1,"type":"notify","title":"claurp","body":"Done."}"#
        XCTAssertEqual(try decode(json), .notify(NotifyPayload(
            title: "claurp", body: "Done.", sessionId: nil, requestId: nil, actions: [])))
    }

    func testDecodeNotifyWithOpenTerminalAction() throws {
        let json = #"{"v":1,"type":"notify","title":"t","body":"b","sessionId":"s-1","requestId":"r-1","actions":["allow","deny","open-terminal"]}"#
        XCTAssertEqual(try decode(json), .notify(NotifyPayload(
            title: "t", body: "b", sessionId: "s-1", requestId: "r-1",
            actions: [.allow, .deny, .openTerminal])))
    }

    func testDecodeSpeakStop() throws {
        XCTAssertEqual(try decode(#"{"v":1,"type":"speak.stop"}"#), .speakStop)
    }

    // ---- tolerance policy (spec §2) ----

    func testUnknownTypeReturnsNil() throws {
        XCTAssertNil(try decode(#"{"v":1,"type":"future.thing","x":1}"#))
    }

    func testUnknownEnumMemberReturnsNil() throws {
        XCTAssertNil(try decode(#"{"v":1,"type":"state","mode":"daydreaming"}"#))
        XCTAssertNil(try decode(#"{"v":1,"type":"notify","title":"t","body":"b","actions":["explode"]}"#))
    }

    func testExtraUnknownFieldsAreIgnored() throws {
        XCTAssertEqual(try decode(#"{"v":1,"type":"transcript.partial","text":"hi","futureField":true}"#),
                       .transcriptPartial(text: "hi"))
    }

    func testMissingRequiredFieldThrowsMalformed() {
        XCTAssertThrowsError(try decode(#"{"v":1,"type":"state"}"#))
        XCTAssertThrowsError(try decode(#"{"v":1,"type":"hud.permission","sessionId":"s"}"#))
    }

    func testGarbageThrowsMalformed() {
        XCTAssertThrowsError(try decode("not json"))
    }

    // ---- encoding senses → daemon ----

    func testEncodeHello() throws {
        let data = try WireCodec.encode(.hello(client: "senses-macos"))
        XCTAssertEqual(try dict(data),
            ["v": 1, "type": "hello", "client": "senses-macos", "protocol": 1])
    }

    func testEncodePtt() throws {
        XCTAssertEqual(try dict(try WireCodec.encode(.ptt(action: .down))),
            ["v": 1, "type": "ptt", "action": "down"])
    }

    func testEncodePermissionResponse() throws {
        let data = try WireCodec.encode(.permissionResponse(
            sessionId: "s-1", requestId: "r-1", decision: .always))
        XCTAssertEqual(try dict(data),
            ["v": 1, "type": "permission.response", "sessionId": "s-1",
             "requestId": "r-1", "decision": "always"])
    }
}
