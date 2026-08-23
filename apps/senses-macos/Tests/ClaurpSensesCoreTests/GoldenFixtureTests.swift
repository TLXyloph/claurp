import XCTest
@testable import ClaurpSensesCore

final class GoldenFixtureTests: XCTestCase {
    static let pcmPattern: [Int16] = [0, 1, -1, 2, -2, 32767, -32768, 12345, -12345, 256]

    static let daemonCases: [(file: String, expected: DaemonMessage)] = [
        ("hello.ack", .helloAck(daemonVersion: "0.1.0")),
        ("state-idle", .state(mode: .idle)),
        ("state-listening", .state(mode: .listening)),
        ("state-working", .state(mode: .working)),
        ("state-needs-you", .state(mode: .needsYou)),
        ("state-disconnected", .state(mode: .disconnected)),
        ("transcript-partial", .transcriptPartial(text: "open the")),
        ("transcript-final", .transcriptFinal(text: "open the notes file")),
        ("earcon-wake-ack", .earcon(kind: .wakeAck)),
        ("earcon-shutter", .earcon(kind: .shutter)),
        ("earcon-permission-ask", .earcon(kind: .permissionAsk)),
        ("earcon-done", .earcon(kind: .done)),
        ("hud-session-spawning", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .spawning, permissionMode: .standard, narration: "Spinning up."))),
        ("hud-session-working", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .working, permissionMode: .acceptEdits, narration: "Editing the file."))),
        ("hud-session-needs-permission", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .needsPermission, permissionMode: .bypassPermissions, narration: "Waiting on you."))),
        ("hud-session-needs-input", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .needsInput, permissionMode: .plan, narration: "Question for you."))),
        ("hud-session-done", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .done, permissionMode: .standard, narration: nil))),
        ("hud-session-failed", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .failed, permissionMode: .standard, narration: "It failed."))),
        ("hud-session-handed-off", .hudSession(HudSession(sessionId: "s-1", label: "notes app", state: .handedOff, permissionMode: .standard, narration: "In your terminal."))),
        ("hud-permission", .hudPermission(HudPermission(sessionId: "s-1", requestId: "r-1", tool: "Bash", detail: "rm -r build/", spoken: "The agent wants to delete the build folder."))),
        ("notify-permission", .notify(NotifyPayload(title: "notes app needs permission", body: "Bash: rm -r build/", sessionId: "s-1", requestId: "r-1", actions: [.allow, .deny]))),
        ("notify-plain", .notify(NotifyPayload(title: "claurp", body: "Session finished.", sessionId: nil, requestId: nil, actions: []))),
        ("notify-open-terminal", .notify(NotifyPayload(title: "notes app", body: "Ready for review.", sessionId: "s-1", requestId: nil, actions: [.allow, .deny, .openTerminal]))),
        ("speak.stop", .speakStop),
    ]

    static let sensesCases: [(file: String, msg: SensesMessage)] = [
        ("hello", .hello(client: "senses-macos")),
        ("ptt-down", .ptt(action: .down)),
        ("ptt-up", .ptt(action: .up)),
        ("permission-response-allow", .permissionResponse(sessionId: "s-1", requestId: "r-1", decision: .allow)),
        ("permission-response-deny", .permissionResponse(sessionId: "s-1", requestId: "r-1", decision: .deny)),
        ("permission-response-always", .permissionResponse(sessionId: "s-1", requestId: "r-1", decision: .always)),
    ]

    private func fixture(_ subdir: String, _ name: String, _ ext: String) throws -> Data {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: ext,
                              subdirectory: "Fixtures/\(subdir)"),
            "missing fixture \(subdir)/\(name).\(ext) — run: pnpm --filter @claurp/protocol golden")
        return try Data(contentsOf: url)
    }

    func testEveryDaemonFixtureDecodesToExpected() throws {
        for (file, expected) in Self.daemonCases {
            let data = try fixture("daemon-to-senses", file, "json")
            XCTAssertEqual(try WireCodec.decodeDaemon(data), expected, file)
        }
    }

    func testEverySensesFixtureMatchesSwiftEncoding() throws {
        for (file, msg) in Self.sensesCases {
            let fixtureObj = try JSONSerialization.jsonObject(
                with: try fixture("senses-to-daemon", file, "json")) as? NSDictionary
            let encodedObj = try JSONSerialization.jsonObject(
                with: try WireCodec.encode(msg)) as? NSDictionary
            XCTAssertEqual(encodedObj, fixtureObj, file)
        }
    }

    func testBinaryFixturesRoundTrip() throws {
        let mic = try fixture("frames", "mic", "bin")
        XCTAssertEqual(mic, FrameCodec.encode(.micPcm16k, pcm: Self.pcmPattern))
        let tts = try fixture("frames", "tts", "bin")
        let decoded = try FrameCodec.decode(tts)
        XCTAssertEqual(decoded.type, 0x02)
        XCTAssertEqual(decoded.pcm, Self.pcmPattern)
    }

    func testNoFixtureFileIsLeftUncovered() throws {
        // A new fixture the daemon starts emitting must be added to the tables above.
        let present = Set((Bundle.module.urls(forResourcesWithExtension: "json",
                                              subdirectory: "Fixtures/daemon-to-senses") ?? [])
            .map { $0.deletingPathExtension().lastPathComponent })
        XCTAssertEqual(present, Set(Self.daemonCases.map { $0.file }))

        let sensesPresent = Set((Bundle.module.urls(forResourcesWithExtension: "json",
                                                    subdirectory: "Fixtures/senses-to-daemon") ?? [])
            .map { $0.deletingPathExtension().lastPathComponent })
        XCTAssertEqual(sensesPresent, Set(Self.sensesCases.map { $0.file }))
    }
}
