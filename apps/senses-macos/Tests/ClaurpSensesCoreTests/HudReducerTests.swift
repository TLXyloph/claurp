import XCTest
@testable import ClaurpSensesCore

final class HudReducerTests: XCTestCase {
    private func run(_ events: [HudEvent], from state: HudState = HudState()) -> HudState {
        events.reduce(state) { HudReducer.reduce($0, $1) }
    }
    private let online: HudEvent = .connection(.connected(daemonVersion: "0.1.0"))
    private let card = HudPermission(sessionId: "s-1", requestId: "r-1", tool: "Bash",
                                     detail: "rm -r build/", spoken: "spoken")

    func testStartsOfflineAndHiddenUntilConnected() {
        let s = HudState()
        XCTAssertEqual(s.pill, .offline)
        let after = run([online, .daemon(.state(mode: .idle))])
        XCTAssertFalse(after.offline)
        XCTAssertEqual(after.pill, .hidden)
    }

    func testListeningShowsLiveTranscript() {
        let s = run([online,
                     .daemon(.state(mode: .listening)),
                     .daemon(.transcriptPartial(text: "open the")),
                     .daemon(.transcriptPartial(text: "open the notes"))])
        XCTAssertEqual(s.pill, .listening(transcript: "open the notes"))
    }

    func testFinalTranscriptHoldsUntilModeChanges() {
        var s = run([online,
                     .daemon(.state(mode: .listening)),
                     .daemon(.transcriptFinal(text: "open the notes file"))])
        XCTAssertEqual(s.transcript, "open the notes file")
        XCTAssertTrue(s.transcriptIsFinal)
        s = HudReducer.reduce(s, .daemon(.state(mode: .listening)))  // same mode re-sent
        XCTAssertEqual(s.transcript, "open the notes file")           // still held
        s = HudReducer.reduce(s, .daemon(.state(mode: .working)))     // mode change
        XCTAssertEqual(s.transcript, "")
        XCTAssertFalse(s.transcriptIsFinal)
    }

    func testWorkingShowsLabelAndLatestNarration() {
        let session = HudSession(sessionId: "s-1", label: "notes app", state: .working,
                                 permissionMode: .standard, narration: "Editing.")
        let s = run([online, .daemon(.state(mode: .working)), .daemon(.hudSession(session))])
        XCTAssertEqual(s.pill, .working(label: "notes app", narration: "Editing."))
    }

    func testNilNarrationKeepsPreviousForSameSessionResetsForNew() {
        let first = HudSession(sessionId: "s-1", label: "notes app", state: .working,
                               permissionMode: .standard, narration: "Editing.")
        let sameNil = HudSession(sessionId: "s-1", label: "notes app", state: .working,
                                 permissionMode: .standard, narration: nil)
        let newNil = HudSession(sessionId: "s-2", label: "other app", state: .spawning,
                                permissionMode: .standard, narration: nil)
        var s = run([online, .daemon(.state(mode: .working)), .daemon(.hudSession(first)),
                     .daemon(.hudSession(sameNil))])
        XCTAssertEqual(s.narration, "Editing.")
        s = HudReducer.reduce(s, .daemon(.hudSession(newNil)))
        XCTAssertEqual(s.narration, "")
        XCTAssertEqual(s.sessionLabel, "other app")
    }

    func testPermissionCardShowsAndClears() {
        var s = run([online, .daemon(.state(mode: .needsYou)), .daemon(.hudPermission(card))])
        XCTAssertEqual(s.pill, .permission(card))
        s = HudReducer.reduce(s, .permissionResolved)
        XCTAssertNil(s.permission)
        s = run([online, .daemon(.state(mode: .needsYou)), .daemon(.hudPermission(card)),
                 .daemon(.state(mode: .working))])
        XCTAssertNil(s.permission) // mode moved off needs-you
    }

    func testNeedsYouWithoutCardFallsBackToWorkingPill() {
        let session = HudSession(sessionId: "s-1", label: "notes app", state: .needsInput,
                                 permissionMode: .standard, narration: "Question.")
        let s = run([online, .daemon(.hudSession(session)), .daemon(.state(mode: .needsYou))])
        XCTAssertEqual(s.pill, .working(label: "notes app", narration: "Question."))
    }

    func testDisconnectGoesOfflineAndClearsCard() {
        let s = run([online, .daemon(.state(mode: .needsYou)), .daemon(.hudPermission(card)),
                     .connection(.disconnected)])
        XCTAssertTrue(s.offline)
        XCTAssertNil(s.permission)
        XCTAssertEqual(s.pill, .offline)
    }

    func testPauseIsTracked() {
        let s = run([online, .pause(true)])
        XCTAssertTrue(s.paused)
    }

    func testNonHudMessagesLeaveStateUntouched() {
        let base = run([online, .daemon(.state(mode: .listening))])
        for msg: DaemonMessage in [.speakStop, .earcon(kind: .done),
                                   .notify(NotifyPayload(title: "t", body: "b", sessionId: nil,
                                                         requestId: nil, actions: [])),
                                   .helloAck(daemonVersion: "0.1.0")] {
            XCTAssertEqual(HudReducer.reduce(base, .daemon(msg)), base)
        }
    }
}
