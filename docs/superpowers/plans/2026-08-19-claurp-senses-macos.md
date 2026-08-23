# claurp senses (macOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `apps/senses-macos` — a menu-bar Swift app that streams the mic to the claurp daemon over the frozen v1 WebSocket protocol, plays TTS audio gaplessly with instant barge-in, and shows a floating HUD pill with transcript, narration, and Allow/Deny permission cards.

**Architecture:** All logic lives in a SwiftPM library `ClaurpSensesCore` (protocol Codable mirror, PCM resampler/chunker, playback controller, connection state machine, HUD reducer, orchestration controller) tested with `swift test`. A thin `ClaurpSenses` app target (AppKit shell: status item, NSPanel pill, earcons, notifications, hotkey) is wrapped into a `.app` by XcodeGen. Cross-language drift is blocked by golden fixtures: a TS script emits canonical JSON + binary frames from the real zod schemas; the Linux CI job fails on fixture drift; Swift tests replay every fixture.

**Tech Stack:** Swift 5.9 / SwiftPM, XcodeGen, AVFoundation (AVAudioEngine, AVAudioConverter), URLSessionWebSocketTask, Network.framework (test stub server only), Carbon `RegisterEventHotKey`, UNUserNotificationCenter. TS side: `tsx` script in `packages/protocol` for fixture emission. **No third-party Swift dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-19-claurp-senses-macos-design.md` — read all of it before starting. §2 (protocol mirror + decoding policy), §3 (audio requirements), §5 (connection), §6 (testing) are normative for this plan.

## Global Constraints

- **Protocol v1 is FROZEN.** No edits to `packages/protocol/src/messages.ts` message shapes. The only TS changes in this plan are additive dev tooling (fixture scripts, one vitest file, CI steps).
- **Raw audio never leaves the machine** (v1 spec §2.2): the app talks only to `ws://127.0.0.1:8765`.
- **Wire names are law.** JSON keys and enum raw values must match `messages.ts` byte-for-byte: `needs-you`, `wake-ack`, `permission-ask`, `handed-off`, `open-terminal`, `permission.response`, `speak.stop`, etc. Swift case names may be Swifty; raw values may not.
- **Unknown daemon input never crashes** (spec §2): unknown message `type` or enum member → log + drop (decoder returns `nil`); structurally malformed JSON or binary → log + drop (decoder throws, caller catches).
- **Gapless playback + instant barge-in are requirements** (spec §3.2): ~100 ms pre-roll, stop-and-flush on `speak.stop` AND on `earcon wake-ack` within 50 ms.
- Mic chunks are **320 samples (20 ms) of 16 kHz mono Int16**, frame type `0x01`; TTS is 24 kHz mono Int16, frame type `0x02`. Binary framing: `[1 byte type][little-endian PCM16]`.
- macOS 14+, Apple Silicon first. App target: `LSUIElement = true`, `NSMicrophoneUsageDescription` set, unsandboxed, ad-hoc signed (signing/packaging is Plan 3).
- Files under 500 lines (project CLAUDE.md). TDD: failing test first for everything in `ClaurpSensesCore`. Conventional commits (`feat:`, `test:`, `chore:`, `ci:`); commit at the end of every task.
- **Threading policy:** everything in `ClaurpSensesCore` assumes the main thread. Adapters that receive callbacks on other threads (audio tap, URLSession) marshal to main themselves. No locks in Core.
- **Vendor drift note (carry-forward from Plan 1):** if AVAudioConverter / Network.framework / XcodeGen APIs differ from the snippets here, adapt the *wrapper/config only* — never weaken a frozen test's assertions to make an API fit.

## File structure (locked by this plan)

```
apps/senses-macos/
  Package.swift
  project.yml
  Sources/ClaurpSensesCore/
    Version.swift                      client name constant
    Protocol/FrameCodec.swift          binary frame encode/decode
    Protocol/Messages.swift            enums + payload structs + DaemonMessage/SensesMessage
    Protocol/WireCodec.swift           JSON encode (senses→daemon) + tolerant decode (daemon→senses)
    Audio/MicResampler.swift           AVAudioConverter wrapper → 16 kHz Int16
    Audio/PcmChunker.swift             320-sample chunk accumulator
    Audio/MicCaptureEngine.swift       AVAudioEngine tap (MicCaptureType impl)
    Audio/TtsPlayback.swift            PcmScheduler protocol + TtsPlaybackController
    Audio/EnginePcmScheduler.swift     AVAudioPlayerNode-backed PcmScheduler
    Connection/WsTransport.swift       WsTransport protocol + WsTransportEvent
    Connection/Backoff.swift           0.5s→10s doubling with jitter
    Connection/ConnectionManager.swift state machine: hello-first, ack gate, reconnect
    Connection/UrlSessionWsTransport.swift  real transport
    Hud/HudState.swift                 HudState + computed Pill
    Hud/HudReducer.swift               HudEvent + pure reducer
    SensesController.swift             orchestration: routing, barge-in, pause, ptt, respond
  Sources/ClaurpSenses/                (app target — Task 13+)
    main.swift, AppDelegate.swift, StatusIcon.swift,
    PillPanel.swift, PillView.swift, HudStore.swift,
    EarconPlayer.swift, NotificationPresenter.swift, PttHotKey.swift
  Resources/Earcons/*.wav              4 committed earcons (generated by script)
  scripts/gen-earcons.swift            one-off WAV synthesizer (committed, run manually)
  Tests/ClaurpSensesCoreTests/         one test file per Core file + GoldenFixtureTests
    Fixtures/                          committed golden fixtures (generated by TS)
packages/protocol/scripts/golden-samples.ts        fixture sample data
packages/protocol/scripts/emit-golden-fixtures.ts  fixture writer
packages/protocol/test/golden.test.ts              enum-coverage vitest
.github/workflows/ci.yml               + drift gate (ubuntu) + senses job (macos)
```

---

### Task 1: SwiftPM package scaffold

**Files:**
- Create: `apps/senses-macos/Package.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Version.swift`
- Create: `apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures/.gitkeep`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/VersionTests.swift`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the package every later task builds in; `ClaurpSenses.clientName == "senses-macos"`; test resources bundle containing `Fixtures/`.

- [ ] **Step 1: Write the failing test**

`Tests/ClaurpSensesCoreTests/VersionTests.swift`:

```swift
import XCTest
@testable import ClaurpSensesCore

final class VersionTests: XCTestCase {
    func testClientName() {
        XCTAssertEqual(ClaurpSenses.clientName, "senses-macos")
    }
}
```

- [ ] **Step 2: Scaffold the package**

`apps/senses-macos/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaurpSenses",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ClaurpSensesCore", targets: ["ClaurpSensesCore"])
    ],
    targets: [
        .target(
            name: "ClaurpSensesCore",
            path: "Sources/ClaurpSensesCore"
        ),
        .testTarget(
            name: "ClaurpSensesCoreTests",
            dependencies: ["ClaurpSensesCore"],
            path: "Tests/ClaurpSensesCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
```

`Sources/ClaurpSensesCore/Version.swift`:

```swift
public enum ClaurpSenses {
    public static let clientName = "senses-macos"
}
```

Create the empty fixtures dir so the `.copy("Fixtures")` resource resolves: add `Tests/ClaurpSensesCoreTests/Fixtures/.gitkeep` (empty file).

Append to `.gitignore` (root):

```
.build/
.swiftpm/
DerivedData/
*.xcodeproj
```

- [ ] **Step 3: Run the test**

Run: `swift test --package-path apps/senses-macos`
Expected: PASS (1 test).

- [ ] **Step 4: Commit**

```bash
git add apps/senses-macos .gitignore
git commit -m "feat(senses): SwiftPM scaffold for ClaurpSensesCore"
```

---

### Task 2: Binary frame codec

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Protocol/FrameCodec.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/FrameCodecTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `enum BinaryFrameType: UInt8 { case micPcm16k = 0x01; case ttsPcm24k = 0x02 }`; `enum FrameCodecError: Error, Equatable { case malformed }`; `enum FrameCodec { static func encode(_ type: BinaryFrameType, pcm: [Int16]) -> Data; static func decode(_ data: Data) throws -> (type: UInt8, pcm: [Int16]) }`. Decode returns the raw type byte (unknown types pass through; the caller decides to drop).

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/FrameCodecTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter FrameCodecTests`
Expected: FAIL — `FrameCodec` not found.

- [ ] **Step 3: Implement**

`Sources/ClaurpSensesCore/Protocol/FrameCodec.swift`:

```swift
import Foundation

public enum BinaryFrameType: UInt8 {
    case micPcm16k = 0x01
    case ttsPcm24k = 0x02
}

public enum FrameCodecError: Error, Equatable {
    case malformed
}

/// Mirrors packages/protocol messages.ts: [1 byte type][little-endian PCM16 payload].
public enum FrameCodec {
    public static func encode(_ type: BinaryFrameType, pcm: [Int16]) -> Data {
        var data = Data(capacity: 1 + pcm.count * 2)
        data.append(type.rawValue)
        for sample in pcm {
            let le = UInt16(bitPattern: sample)
            data.append(UInt8(le & 0xFF))
            data.append(UInt8(le >> 8))
        }
        return data
    }

    public static func decode(_ data: Data) throws -> (type: UInt8, pcm: [Int16]) {
        guard data.count >= 1, (data.count - 1) % 2 == 0 else {
            throw FrameCodecError.malformed
        }
        let bytes = [UInt8](data) // normalizes slice indices
        let type = bytes[0]
        var pcm = [Int16]()
        pcm.reserveCapacity((bytes.count - 1) / 2)
        var i = 1
        while i < bytes.count {
            pcm.append(Int16(bitPattern: UInt16(bytes[i]) | (UInt16(bytes[i + 1]) << 8)))
            i += 2
        }
        return (type, pcm)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter FrameCodecTests`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): binary PCM16 frame codec mirroring protocol v1"
```

---

### Task 3: Wire messages — types, encoder, tolerant decoder

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Protocol/Messages.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Protocol/WireCodec.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/WireCodecTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces (all `public`, all `Equatable`):
  - Enums (String raw values = wire values): `StateMode` (`idle, listening, working, needsYou="needs-you", disconnected`), `EarconKind` (`wakeAck="wake-ack", shutter, permissionAsk="permission-ask", done`), `SessionState` (`spawning, working, needsPermission="needs-permission", needsInput="needs-input", done, failed, handedOff="handed-off"`), `PermissionMode` (`standard="default", acceptEdits, plan, bypassPermissions` — `standard` avoids backticked `` `default` ``), `NotifyAction` (`allow, deny, openTerminal="open-terminal"`), `PttAction` (`down, up`), `PermissionDecision` (`allow, deny, always`).
  - Structs with public memberwise inits: `HudSession { sessionId, label: String; state: SessionState; permissionMode: PermissionMode; narration: String? }`, `HudPermission { sessionId, requestId, tool, detail, spoken: String }`, `NotifyPayload { title, body: String; sessionId, requestId: String?; actions: [NotifyAction] }`.
  - `enum DaemonMessage: Equatable { case helloAck(daemonVersion: String), state(mode: StateMode), transcriptPartial(text: String), transcriptFinal(text: String), earcon(kind: EarconKind), hudSession(HudSession), hudPermission(HudPermission), notify(NotifyPayload), speakStop }`
  - `enum SensesMessage: Equatable { case hello(client: String), ptt(action: PttAction), permissionResponse(sessionId: String, requestId: String, decision: PermissionDecision) }`
  - `enum WireDecodeError: Error, Equatable { case malformed }`
  - `enum WireCodec { static let protocolVersion = 1; static func encode(_ msg: SensesMessage) throws -> Data; static func decodeDaemon(_ data: Data) throws -> DaemonMessage? }` — **nil = tolerated-unknown (drop + log); throws = malformed (drop + log).**

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/WireCodecTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter WireCodecTests`
Expected: FAIL — types not found.

- [ ] **Step 3: Implement `Messages.swift`**

```swift
public enum StateMode: String, Equatable {
    case idle, listening, working, disconnected
    case needsYou = "needs-you"
}

public enum EarconKind: String, Equatable {
    case shutter, done
    case wakeAck = "wake-ack"
    case permissionAsk = "permission-ask"
}

public enum SessionState: String, Equatable {
    case spawning, working, done, failed
    case needsPermission = "needs-permission"
    case needsInput = "needs-input"
    case handedOff = "handed-off"
}

/// `standard` maps to the wire value "default" (a Swift keyword).
public enum PermissionMode: String, Equatable {
    case standard = "default"
    case acceptEdits, plan, bypassPermissions
}

public enum NotifyAction: String, Equatable {
    case allow, deny
    case openTerminal = "open-terminal"
}

public enum PttAction: String, Equatable { case down, up }

public enum PermissionDecision: String, Equatable { case allow, deny, always }

public struct HudSession: Equatable {
    public let sessionId: String
    public let label: String
    public let state: SessionState
    public let permissionMode: PermissionMode
    public let narration: String?
    public init(sessionId: String, label: String, state: SessionState,
                permissionMode: PermissionMode, narration: String?) {
        self.sessionId = sessionId
        self.label = label
        self.state = state
        self.permissionMode = permissionMode
        self.narration = narration
    }
}

public struct HudPermission: Equatable {
    public let sessionId: String
    public let requestId: String
    public let tool: String
    public let detail: String
    public let spoken: String
    public init(sessionId: String, requestId: String, tool: String,
                detail: String, spoken: String) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.tool = tool
        self.detail = detail
        self.spoken = spoken
    }
}

public struct NotifyPayload: Equatable {
    public let title: String
    public let body: String
    public let sessionId: String?
    public let requestId: String?
    public let actions: [NotifyAction]
    public init(title: String, body: String, sessionId: String?,
                requestId: String?, actions: [NotifyAction]) {
        self.title = title
        self.body = body
        self.sessionId = sessionId
        self.requestId = requestId
        self.actions = actions
    }
}

public enum DaemonMessage: Equatable {
    case helloAck(daemonVersion: String)
    case state(mode: StateMode)
    case transcriptPartial(text: String)
    case transcriptFinal(text: String)
    case earcon(kind: EarconKind)
    case hudSession(HudSession)
    case hudPermission(HudPermission)
    case notify(NotifyPayload)
    case speakStop
}

public enum SensesMessage: Equatable {
    case hello(client: String)
    case ptt(action: PttAction)
    case permissionResponse(sessionId: String, requestId: String, decision: PermissionDecision)
}
```

- [ ] **Step 4: Implement `WireCodec.swift`**

```swift
import Foundation

public enum WireDecodeError: Error, Equatable {
    case malformed
}

public enum WireCodec {
    public static let protocolVersion = 1

    public static func encode(_ msg: SensesMessage) throws -> Data {
        var dict: [String: Any] = ["v": protocolVersion]
        switch msg {
        case .hello(let client):
            dict["type"] = "hello"
            dict["client"] = client
            dict["protocol"] = protocolVersion
        case .ptt(let action):
            dict["type"] = "ptt"
            dict["action"] = action.rawValue
        case .permissionResponse(let sessionId, let requestId, let decision):
            dict["type"] = "permission.response"
            dict["sessionId"] = sessionId
            dict["requestId"] = requestId
            dict["decision"] = decision.rawValue
        }
        return try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
    }

    /// nil = tolerated-unknown (unknown `type` or enum member): caller logs and drops.
    /// Throws `.malformed` for structurally invalid JSON: caller logs and drops.
    public static func decodeDaemon(_ data: Data) throws -> DaemonMessage? {
        let dec = JSONDecoder()
        struct Head: Decodable { let type: String }
        guard let head = try? dec.decode(Head.self, from: data) else {
            throw WireDecodeError.malformed
        }
        func payload<T: Decodable>(_ type: T.Type) throws -> T {
            guard let p = try? dec.decode(T.self, from: data) else {
                throw WireDecodeError.malformed
            }
            return p
        }

        switch head.type {
        case "hello.ack":
            struct P: Decodable { let daemonVersion: String }
            return .helloAck(daemonVersion: try payload(P.self).daemonVersion)
        case "state":
            struct P: Decodable { let mode: String }
            guard let mode = StateMode(rawValue: try payload(P.self).mode) else { return nil }
            return .state(mode: mode)
        case "transcript.partial":
            struct P: Decodable { let text: String }
            return .transcriptPartial(text: try payload(P.self).text)
        case "transcript.final":
            struct P: Decodable { let text: String }
            return .transcriptFinal(text: try payload(P.self).text)
        case "earcon":
            struct P: Decodable { let kind: String }
            guard let kind = EarconKind(rawValue: try payload(P.self).kind) else { return nil }
            return .earcon(kind: kind)
        case "hud.session":
            struct P: Decodable {
                let sessionId: String
                let label: String
                let state: String
                let permissionMode: String
                let narration: String?
            }
            let p = try payload(P.self)
            guard let state = SessionState(rawValue: p.state),
                  let mode = PermissionMode(rawValue: p.permissionMode) else { return nil }
            return .hudSession(HudSession(sessionId: p.sessionId, label: p.label,
                                          state: state, permissionMode: mode,
                                          narration: p.narration))
        case "hud.permission":
            struct P: Decodable { let sessionId, requestId, tool, detail, spoken: String }
            let p = try payload(P.self)
            return .hudPermission(HudPermission(sessionId: p.sessionId, requestId: p.requestId,
                                                tool: p.tool, detail: p.detail, spoken: p.spoken))
        case "notify":
            struct P: Decodable {
                let title: String
                let body: String
                let sessionId: String?
                let requestId: String?
                let actions: [String]?
            }
            let p = try payload(P.self)
            var actions: [NotifyAction] = []
            for raw in p.actions ?? [] {
                guard let action = NotifyAction(rawValue: raw) else { return nil }
                actions.append(action)
            }
            return .notify(NotifyPayload(title: p.title, body: p.body,
                                         sessionId: p.sessionId, requestId: p.requestId,
                                         actions: actions))
        case "speak.stop":
            return .speakStop
        default:
            return nil
        }
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter WireCodecTests`
Expected: PASS (14 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): Swift wire-message mirror with tolerant decoding"
```

---

### Task 4: Golden fixture generator (TS) + Linux CI drift gate

**Files:**
- Create: `packages/protocol/scripts/golden-samples.ts`
- Create: `packages/protocol/scripts/emit-golden-fixtures.ts`
- Test: `packages/protocol/test/golden.test.ts`
- Modify: `packages/protocol/package.json` (add `golden` script + `tsx` devDep)
- Modify: `.github/workflows/ci.yml` (drift-gate step in the ubuntu job)
- Generated + committed: `apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures/**`

**Interfaces:**
- Consumes: the frozen zod schemas and `encodeBinaryFrame` from `@claurp/protocol` src.
- Produces: committed fixtures at `apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures/{daemon-to-senses,senses-to-daemon,frames}/`; `pnpm --filter @claurp/protocol golden` regenerates them; CI fails if regeneration changes anything. The shared PCM test pattern is `[0, 1, -1, 2, -2, 32767, -32768, 12345, -12345, 256]` (Task 5 hard-codes the same array in Swift).

- [ ] **Step 1: Write the sample data**

`packages/protocol/scripts/golden-samples.ts`:

```ts
// Golden-fixture samples. One entry per wire shape; every enum variant of
// every message type must appear at least once (test/golden.test.ts enforces).
// Written as the daemon writes them (pre-zod-parse), so optional fields may
// be absent — the Swift decoder must handle both presence and absence.
import { PROTOCOL_VERSION } from "../src/messages.js";

const v = PROTOCOL_VERSION;

export const PCM_PATTERN = [0, 1, -1, 2, -2, 32767, -32768, 12345, -12345, 256];

export const daemonToSenses: Array<{ file: string; msg: unknown }> = [
  { file: "hello.ack", msg: { v, type: "hello.ack", daemonVersion: "0.1.0" } },

  { file: "state-idle", msg: { v, type: "state", mode: "idle" } },
  { file: "state-listening", msg: { v, type: "state", mode: "listening" } },
  { file: "state-working", msg: { v, type: "state", mode: "working" } },
  { file: "state-needs-you", msg: { v, type: "state", mode: "needs-you" } },
  { file: "state-disconnected", msg: { v, type: "state", mode: "disconnected" } },

  { file: "transcript-partial", msg: { v, type: "transcript.partial", text: "open the" } },
  { file: "transcript-final", msg: { v, type: "transcript.final", text: "open the notes file" } },

  { file: "earcon-wake-ack", msg: { v, type: "earcon", kind: "wake-ack" } },
  { file: "earcon-shutter", msg: { v, type: "earcon", kind: "shutter" } },
  { file: "earcon-permission-ask", msg: { v, type: "earcon", kind: "permission-ask" } },
  { file: "earcon-done", msg: { v, type: "earcon", kind: "done" } },

  { file: "hud-session-spawning", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "spawning", permissionMode: "default", narration: "Spinning up." } },
  { file: "hud-session-working", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "working", permissionMode: "acceptEdits", narration: "Editing the file." } },
  { file: "hud-session-needs-permission", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "needs-permission", permissionMode: "bypassPermissions", narration: "Waiting on you." } },
  { file: "hud-session-needs-input", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "needs-input", permissionMode: "plan", narration: "Question for you." } },
  { file: "hud-session-done", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "done", permissionMode: "default" } },
  { file: "hud-session-failed", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "failed", permissionMode: "default", narration: "It failed." } },
  { file: "hud-session-handed-off", msg: { v, type: "hud.session", sessionId: "s-1", label: "notes app", state: "handed-off", permissionMode: "default", narration: "In your terminal." } },

  { file: "hud-permission", msg: { v, type: "hud.permission", sessionId: "s-1", requestId: "r-1", tool: "Bash", detail: "rm -r build/", spoken: "The agent wants to delete the build folder." } },

  { file: "notify-permission", msg: { v, type: "notify", title: "notes app needs permission", body: "Bash: rm -r build/", sessionId: "s-1", requestId: "r-1", actions: ["allow", "deny"] } },
  { file: "notify-plain", msg: { v, type: "notify", title: "claurp", body: "Session finished." } },
  { file: "notify-open-terminal", msg: { v, type: "notify", title: "notes app", body: "Ready for review.", sessionId: "s-1", actions: ["allow", "deny", "open-terminal"] } },

  { file: "speak.stop", msg: { v, type: "speak.stop" } },
];

export const sensesToDaemon: Array<{ file: string; msg: unknown }> = [
  { file: "hello", msg: { v, type: "hello", client: "senses-macos", protocol: v } },
  { file: "ptt-down", msg: { v, type: "ptt", action: "down" } },
  { file: "ptt-up", msg: { v, type: "ptt", action: "up" } },
  { file: "permission-response-allow", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "allow" } },
  { file: "permission-response-deny", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "deny" } },
  { file: "permission-response-always", msg: { v, type: "permission.response", sessionId: "s-1", requestId: "r-1", decision: "always" } },
];

export const frames: Array<{ file: string; type: number; pcm: number[] }> = [
  { file: "mic", type: 0x01, pcm: PCM_PATTERN },
  { file: "tts", type: 0x02, pcm: PCM_PATTERN },
];
```

Note: `notify-plain` deliberately omits `actions` and `hud-session-done` omits `narration` — the daemon sends unparsed objects, so absence is wire-real (zod's `.default([])` applies only on parse).

- [ ] **Step 2: Write the vitest (fails until the samples file exists and covers everything)**

`packages/protocol/test/golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { daemonToSenses, sensesToDaemon, frames } from "../scripts/golden-samples.js";
import { parseDaemonMsg, parseSensesMsg } from "../src/index.js";

type Sample = { file: string; msg: unknown };
const byType = (samples: Sample[], type: string) =>
  samples.filter((s) => (s.msg as { type: string }).type === type);
const field = (samples: Sample[], type: string, key: string) =>
  new Set(byType(samples, type).map((s) => (s.msg as Record<string, unknown>)[key]));

describe("golden samples", () => {
  it("every daemon→senses sample passes the zod schema", () => {
    for (const s of daemonToSenses) expect(() => parseDaemonMsg(s.msg)).not.toThrow();
  });

  it("every senses→daemon sample passes the zod schema", () => {
    for (const s of sensesToDaemon) expect(() => parseSensesMsg(s.msg)).not.toThrow();
  });

  it("filenames are unique per directory", () => {
    for (const list of [daemonToSenses, sensesToDaemon, frames]) {
      expect(new Set(list.map((s) => s.file)).size).toBe(list.length);
    }
  });

  it("covers every enum variant", () => {
    expect(field(daemonToSenses, "state", "mode")).toEqual(
      new Set(["idle", "listening", "working", "needs-you", "disconnected"]));
    expect(field(daemonToSenses, "earcon", "kind")).toEqual(
      new Set(["wake-ack", "shutter", "permission-ask", "done"]));
    expect(field(daemonToSenses, "hud.session", "state")).toEqual(
      new Set(["spawning", "working", "needs-permission", "needs-input", "done", "failed", "handed-off"]));
    expect(field(daemonToSenses, "hud.session", "permissionMode")).toEqual(
      new Set(["default", "acceptEdits", "plan", "bypassPermissions"]));
    expect(field(sensesToDaemon, "ptt", "action")).toEqual(new Set(["down", "up"]));
    expect(field(sensesToDaemon, "permission.response", "decision")).toEqual(
      new Set(["allow", "deny", "always"]));
    const notifyActions = new Set(
      byType(daemonToSenses, "notify").flatMap((s) => ((s.msg as { actions?: string[] }).actions ?? [])));
    expect(notifyActions).toEqual(new Set(["allow", "deny", "open-terminal"]));
  });
});
```

Run: `pnpm --filter @claurp/protocol test`
Expected: PASS once Step 1's file exists (write the test first if you prefer strict ordering; the coverage assertions are the real teeth).

- [ ] **Step 3: Write the emitter**

`packages/protocol/scripts/emit-golden-fixtures.ts`:

```ts
// Regenerates the Swift test fixtures from the real zod schemas.
// Run: pnpm --filter @claurp/protocol golden
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeBinaryFrame, parseDaemonMsg, parseSensesMsg } from "../src/index.js";
import { daemonToSenses, sensesToDaemon, frames } from "./golden-samples.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(repoRoot, "apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures");

rmSync(out, { recursive: true, force: true });
for (const dir of ["daemon-to-senses", "senses-to-daemon", "frames"]) {
  mkdirSync(path.join(out, dir), { recursive: true });
}

for (const { file, msg } of daemonToSenses) {
  parseDaemonMsg(msg); // throws if a sample ever drifts from the schema
  writeFileSync(path.join(out, "daemon-to-senses", `${file}.json`), JSON.stringify(msg, null, 2) + "\n");
}
for (const { file, msg } of sensesToDaemon) {
  parseSensesMsg(msg);
  writeFileSync(path.join(out, "senses-to-daemon", `${file}.json`), JSON.stringify(msg, null, 2) + "\n");
}
for (const { file, type, pcm } of frames) {
  writeFileSync(path.join(out, "frames", `${file}.bin`), encodeBinaryFrame(type, Int16Array.from(pcm)));
}
console.log(`claurp: wrote golden fixtures to ${out}`);
```

Add to `packages/protocol/package.json`:
- `"scripts"`: add `"golden": "tsx scripts/emit-golden-fixtures.ts"`
- `"devDependencies"`: add `"tsx": "^4.19.0"`

Then: `pnpm install`

- [ ] **Step 4: Generate and inspect**

Run: `pnpm --filter @claurp/protocol golden`
Expected: `claurp: wrote golden fixtures to …/Fixtures`; 30 `.json` files (24 daemon→senses + 6 senses→daemon) + 2 `.bin` files exist; `frames/mic.bin` is 21 bytes starting `0x01`.

Run: `pnpm --filter @claurp/protocol test` — Expected: PASS.

- [ ] **Step 5: Add the CI drift gate**

In `.github/workflows/ci.yml`, in the existing `check` job, add after the `Test` step:

```yaml
      # The Swift app replays these fixtures; if the TS schemas change without
      # regenerating + committing them, fail here (no Mac needed to catch drift).
      - name: Golden fixture drift gate
        run: |
          pnpm --filter @claurp/protocol golden
          git diff --exit-code -- apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures
```

- [ ] **Step 6: Commit (fixtures included)**

```bash
git add packages/protocol .github/workflows/ci.yml pnpm-lock.yaml \
        apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures
git commit -m "feat(protocol): golden wire fixtures + CI drift gate for the Swift mirror"
```

---

### Task 5: Golden fixture replay tests (Swift)

**Files:**
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/GoldenFixtureTests.swift`

**Interfaces:**
- Consumes: `WireCodec`, `FrameCodec`, all message types (Task 3), fixtures (Task 4).
- Produces: the cross-language conformance suite. No new production code — if a fixture fails to decode, **fix `WireCodec`/`Messages`, never the fixture** (fixtures are generated from the source of truth).

- [ ] **Step 1: Write the replay tests**

`Tests/ClaurpSensesCoreTests/GoldenFixtureTests.swift`:

```swift
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
```

- [ ] **Step 2: Run the suite**

Run: `swift test --package-path apps/senses-macos --filter GoldenFixtureTests`
Expected: PASS (4 tests). If any decode fails, the Swift mirror is wrong — fix Task 3's code.

- [ ] **Step 3: Run everything, then commit**

Run: `swift test --package-path apps/senses-macos` — Expected: all PASS.

```bash
git add apps/senses-macos
git commit -m "test(senses): golden fixture replay locks Swift mirror to protocol v1"
```

---

### Task 6: Mic resampler (AVAudioConverter → 16 kHz Int16)

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Audio/MicResampler.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/MicResamplerTests.swift`

**Interfaces:**
- Consumes: AVFoundation only.
- Produces: `final class MicResampler { init?(inputSampleRate: Double); func resample(_ samples: [Float]) -> [Int16] }` — streaming-safe (converter state persists across calls; never send end-of-stream).

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/MicResamplerTests.swift`:

```swift
import XCTest
@testable import ClaurpSensesCore

final class MicResamplerTests: XCTestCase {
    private func sine(freq: Double, rate: Double, seconds: Double, amp: Float) -> [Float] {
        (0..<Int(rate * seconds)).map {
            amp * Float(sin(2.0 * .pi * freq * Double($0) / rate))
        }
    }

    func testDownsamples48kSineTo16k() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 48000))
        let input = sine(freq: 440, rate: 48000, seconds: 1.0, amp: 0.5)
        var out: [Int16] = []
        // Feed in 100 ms chunks like a live tap would.
        for start in stride(from: 0, to: input.count, by: 4800) {
            out += r.resample(Array(input[start..<min(start + 4800, input.count)]))
        }
        // Length: 1 s at 16 kHz, allowing converter priming latency.
        XCTAssertEqual(out.count, 16000, accuracy: 64)

        // Frequency via zero crossings.
        var crossings = 0
        for i in 1..<out.count where (out[i - 1] < 0) != (out[i] < 0) { crossings += 1 }
        let freq = Double(crossings) / 2.0 / (Double(out.count) / 16000.0)
        XCTAssertEqual(freq, 440, accuracy: 10)

        // RMS: 0.5 amplitude sine → 0.5/√2 × 32767 ≈ 11585.
        let rms = (out.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(out.count)).squareRoot()
        XCTAssertEqual(rms, 11585, accuracy: 1200)
    }

    func testPassthroughAt16k() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 16000))
        let input = sine(freq: 200, rate: 16000, seconds: 0.5, amp: 0.25)
        var out: [Int16] = []
        for start in stride(from: 0, to: input.count, by: 1600) {
            out += r.resample(Array(input[start..<min(start + 1600, input.count)]))
        }
        XCTAssertEqual(out.count, 8000, accuracy: 64)
    }

    func testEmptyInputYieldsEmptyOutput() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 48000))
        XCTAssertEqual(r.resample([]), [])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter MicResamplerTests`
Expected: FAIL — `MicResampler` not found.

- [ ] **Step 3: Implement**

`Sources/ClaurpSensesCore/Audio/MicResampler.swift`:

```swift
import AVFoundation

/// Streaming Float32-mono → 16 kHz Int16-mono converter. One instance per
/// capture session; converter state carries across resample() calls, so
/// never signal end-of-stream (we stream forever).
public final class MicResampler {
    private let converter: AVAudioConverter
    private let inFormat: AVAudioFormat
    private let outFormat: AVAudioFormat
    private let ratio: Double

    public init?(inputSampleRate: Double) {
        guard inputSampleRate > 0,
              let inF = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: inputSampleRate,
                                      channels: 1, interleaved: false),
              let outF = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                       sampleRate: 16000,
                                       channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inF, to: outF) else { return nil }
        inFormat = inF
        outFormat = outF
        converter = conv
        ratio = 16000.0 / inputSampleRate
    }

    public func resample(_ samples: [Float]) -> [Int16] {
        guard !samples.isEmpty,
              let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat,
                                           frameCapacity: AVAudioFrameCount(samples.count)) else {
            return []
        }
        inBuf.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            inBuf.floatChannelData!.pointee.update(from: src.baseAddress!, count: samples.count)
        }

        let outCapacity = AVAudioFrameCount(Double(samples.count) * ratio) + 64
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity) else {
            return []
        }

        var fed = false
        var error: NSError?
        let status = converter.convert(to: outBuf, error: &error) { _, outStatus in
            if fed {
                outStatus.pointee = .noDataNow // keep the stream open for the next call
                return nil
            }
            fed = true
            outStatus.pointee = .haveData
            return inBuf
        }
        guard status != .error, error == nil, outBuf.frameLength > 0,
              let ch = outBuf.int16ChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: ch.pointee, count: Int(outBuf.frameLength)))
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter MicResamplerTests`
Expected: PASS (3 tests). If AVAudioConverter's input-block contract differs on your toolchain, adapt the wrapper — the frequency/RMS/length assertions stay.

- [ ] **Step 5: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): streaming mic resampler to 16 kHz Int16"
```

---

### Task 7: PCM chunker + mic capture engine

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Audio/PcmChunker.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Audio/MicCaptureEngine.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/PcmChunkerTests.swift`

**Interfaces:**
- Consumes: `MicResampler` (Task 6).
- Produces: `struct PcmChunker { init(chunkSize: Int = 320); mutating func push(_ samples: [Int16]) -> [[Int16]]; mutating func reset() }`; `protocol MicCaptureType: AnyObject { var onChunk: (([Int16]) -> Void)? { get set }; var isRunning: Bool { get }; func start() throws; func stop() }`; `final class MicCaptureEngine: MicCaptureType` (delivers `onChunk` **on the main queue**).

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/PcmChunkerTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter PcmChunkerTests`
Expected: FAIL.

- [ ] **Step 3: Implement the chunker**

`Sources/ClaurpSensesCore/Audio/PcmChunker.swift`:

```swift
/// Accumulates arbitrary-size sample batches into fixed 20 ms wire chunks.
public struct PcmChunker {
    public let chunkSize: Int
    private var pending: [Int16] = []

    public init(chunkSize: Int = 320) {
        self.chunkSize = chunkSize
    }

    public mutating func push(_ samples: [Int16]) -> [[Int16]] {
        pending.append(contentsOf: samples)
        var chunks: [[Int16]] = []
        while pending.count >= chunkSize {
            chunks.append(Array(pending.prefix(chunkSize)))
            pending.removeFirst(chunkSize)
        }
        return chunks
    }

    public mutating func reset() {
        pending.removeAll()
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter PcmChunkerTests`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the capture engine (no unit test — real mic; validated manually in Task 13 and the Task 17 smoke)**

`Sources/ClaurpSensesCore/Audio/MicCaptureEngine.swift`:

```swift
import AVFoundation

public protocol MicCaptureType: AnyObject {
    var onChunk: (([Int16]) -> Void)? { get set }
    var isRunning: Bool { get }
    func start() throws
    func stop()
}

/// AVAudioEngine input tap → resample → 320-sample chunks, delivered on main.
/// stop() removes the tap and halts the engine, which turns off the macOS
/// mic-in-use indicator — the honest "Pause listening" signal (spec §3.1).
public final class MicCaptureEngine: MicCaptureType {
    private let engine = AVAudioEngine()
    private var resampler: MicResampler?
    private var chunker = PcmChunker()
    public var onChunk: (([Int16]) -> Void)?
    public private(set) var isRunning = false

    public func start() throws {
        guard !isRunning else { return }
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        resampler = MicResampler(inputSampleRate: format.sampleRate)
        chunker.reset()
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let channels = buffer.floatChannelData else { return }
            let mono = Array(UnsafeBufferPointer(start: channels[0],
                                                 count: Int(buffer.frameLength)))
            guard let resampled = self.resampler?.resample(mono), !resampled.isEmpty else { return }
            DispatchQueue.main.async {
                for chunk in self.chunker.push(resampled) {
                    self.onChunk?(chunk)
                }
            }
        }
        engine.prepare()
        try engine.start()
        isRunning = true
    }

    public func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        chunker.reset()
        isRunning = false
    }
}
```

Note: `chunker` is mutated only on the main queue (inside the `DispatchQueue.main.async`), consistent with the global threading policy.

- [ ] **Step 6: Build + full test run, then commit**

Run: `swift test --package-path apps/senses-macos`
Expected: all PASS (engine compiles; tap untested by design).

```bash
git add apps/senses-macos
git commit -m "feat(senses): pcm chunker and mic capture engine"
```

---

### Task 8: TTS playback controller (pre-roll, barge-in) + engine scheduler

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Audio/TtsPlayback.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Audio/EnginePcmScheduler.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/TtsPlaybackControllerTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `protocol PcmScheduler: AnyObject { func schedule(_ pcm: [Int16]); func startPlayback(); func stopAndFlush() }`; `final class TtsPlaybackController { init(scheduler: PcmScheduler, prerollSamples: Int = 2400); private(set) var isPlaying: Bool; func receive(_ pcm: [Int16]); func bargeIn() }`; `final class EnginePcmScheduler: PcmScheduler` (real AVAudioPlayerNode @ 24 kHz).
- Semantics (spec §3.2): buffers are scheduled immediately; playback starts once ≥ `prerollSamples` (2400 = 100 ms @ 24 kHz) have accumulated; `bargeIn()` stops + flushes and re-arms the pre-roll; barge-in with nothing buffered is a no-op.

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/TtsPlaybackControllerTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter TtsPlaybackControllerTests`
Expected: FAIL.

- [ ] **Step 3: Implement the controller**

`Sources/ClaurpSensesCore/Audio/TtsPlayback.swift`:

```swift
public protocol PcmScheduler: AnyObject {
    func schedule(_ pcm: [Int16])
    func startPlayback()
    func stopAndFlush()
}

/// Gapless-playback gatekeeper (spec §3.2): schedule frames as they arrive,
/// start output only after ~100 ms of audio is queued (absorbs WS jitter),
/// and on barge-in stop + flush immediately, re-arming the pre-roll for the
/// next utterance. Known tradeoff (spec §3.2): pre-roll re-arms only after a
/// barge-in, not after a natural drain.
public final class TtsPlaybackController {
    private let scheduler: PcmScheduler
    private let prerollSamples: Int
    private var buffered = 0
    public private(set) var isPlaying = false

    public init(scheduler: PcmScheduler, prerollSamples: Int = 2400) {
        self.scheduler = scheduler
        self.prerollSamples = prerollSamples
    }

    public func receive(_ pcm: [Int16]) {
        guard !pcm.isEmpty else { return }
        scheduler.schedule(pcm)
        buffered += pcm.count
        if !isPlaying && buffered >= prerollSamples {
            scheduler.startPlayback()
            isPlaying = true
        }
    }

    public func bargeIn() {
        guard isPlaying || buffered > 0 else { return }
        scheduler.stopAndFlush()
        buffered = 0
        isPlaying = false
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter TtsPlaybackControllerTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement the real scheduler (no unit test — audio hardware; validated in Task 17 smoke)**

`Sources/ClaurpSensesCore/Audio/EnginePcmScheduler.swift`:

```swift
import AVFoundation

/// AVAudioPlayerNode-backed output at 24 kHz mono. player.stop() flushes all
/// scheduled buffers synchronously — that is the ≤50 ms barge-in guarantee.
public final class EnginePcmScheduler: PcmScheduler {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: 24000, channels: 1,
                                       interleaved: false)!

    public init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    public func schedule(_ pcm: [Int16]) {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(pcm.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(pcm.count)
        let dst = buffer.floatChannelData!.pointee
        for i in 0..<pcm.count {
            dst[i] = Float(pcm[i]) / 32768.0
        }
        player.scheduleBuffer(buffer)
    }

    public func startPlayback() {
        if !engine.isRunning {
            try? engine.start()
        }
        player.play()
    }

    public func stopAndFlush() {
        player.stop()
    }
}
```

- [ ] **Step 6: Full test run + commit**

Run: `swift test --package-path apps/senses-macos` — Expected: all PASS.

```bash
git add apps/senses-macos
git commit -m "feat(senses): tts playback with preroll gating and barge-in"
```

---

### Task 9: Connection state machine with backoff (mock transport)

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Connection/WsTransport.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Connection/Backoff.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Connection/ConnectionManager.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/BackoffTests.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/ConnectionManagerTests.swift`

**Interfaces:**
- Consumes: `WireCodec`, `FrameCodec`, `DaemonMessage`, `SensesMessage`, `ClaurpSenses.clientName`.
- Produces:
  - `enum WsTransportEvent: Equatable { case opened, text(String), data(Data), closed(reason: String?) }`
  - `protocol WsTransport: AnyObject { var onEvent: ((WsTransportEvent) -> Void)? { get set }; func connect(url: URL); func send(text: String); func send(data: Data); func close() }`
  - `struct Backoff { init(initial: TimeInterval = 0.5, cap: TimeInterval = 10, jitterRange: ClosedRange<Double> = 0.8...1.2, random: @escaping (ClosedRange<Double>) -> Double = { .random(in: $0) }); mutating func next() -> TimeInterval; mutating func reset() }`
  - `enum ConnectionState: Equatable { case disconnected, connecting, helloSent, connected(daemonVersion: String) }`
  - `final class ConnectionManager { init(url: URL, transport: WsTransport, backoff: Backoff = Backoff(), scheduleRetry: @escaping (TimeInterval, @escaping () -> Void) -> Void); private(set) var state: ConnectionState; var onStateChange: ((ConnectionState) -> Void)?; var onDaemonMessage: ((DaemonMessage) -> Void)?; var onTtsPcm: (([Int16]) -> Void)?; func start(); func stop(); func reconnectNow(); func send(_ msg: SensesMessage); func sendMicFrame(_ pcm: [Int16]) }`
- Behavior (spec §5): on open, send `hello` as the **first** text frame; only `hello.ack` completes the handshake (backoff resets there); `send`/`sendMicFrame` silently drop unless `connected`; any close → `disconnected` + scheduled retry (unless `stop()`); malformed/unknown inbound is dropped without a state change; inbound binary frames of type `0x02` surface via `onTtsPcm`, others are dropped.

- [ ] **Step 1: Write the failing Backoff tests**

`Tests/ClaurpSensesCoreTests/BackoffTests.swift`:

```swift
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
```

- [ ] **Step 2: Implement Backoff, run tests**

`Sources/ClaurpSensesCore/Connection/Backoff.swift`:

```swift
import Foundation

/// 0.5 s doubling to a 10 s cap, ±20% jitter (spec §5).
public struct Backoff {
    private let initial: TimeInterval
    private let cap: TimeInterval
    private let jitterRange: ClosedRange<Double>
    private let random: (ClosedRange<Double>) -> Double
    private var current: TimeInterval?

    public init(initial: TimeInterval = 0.5,
                cap: TimeInterval = 10,
                jitterRange: ClosedRange<Double> = 0.8...1.2,
                random: @escaping (ClosedRange<Double>) -> Double = { .random(in: $0) }) {
        self.initial = initial
        self.cap = cap
        self.jitterRange = jitterRange
        self.random = random
    }

    public mutating func next() -> TimeInterval {
        let base = current.map { min($0 * 2, cap) } ?? initial
        current = base
        return base * random(jitterRange)
    }

    public mutating func reset() {
        current = nil
    }
}
```

Run: `swift test --package-path apps/senses-macos --filter BackoffTests` — Expected: PASS (3 tests).

- [ ] **Step 3: Write the failing ConnectionManager tests**

`Tests/ClaurpSensesCoreTests/ConnectionManagerTests.swift`:

```swift
import XCTest
@testable import ClaurpSensesCore

final class MockTransport: WsTransport {
    var onEvent: ((WsTransportEvent) -> Void)?
    var connects: [URL] = []
    var sentTexts: [String] = []
    var sentData: [Data] = []
    var closeCount = 0
    func connect(url: URL) { connects.append(url) }
    func send(text: String) { sentTexts.append(text) }
    func send(data: Data) { sentData.append(data) }
    func close() { closeCount += 1 }
}

final class ConnectionManagerTests: XCTestCase {
    var transport: MockTransport!
    var retries: [(delay: TimeInterval, block: () -> Void)]!
    var manager: ConnectionManager!
    var states: [ConnectionState]!

    override func setUp() {
        super.setUp()
        transport = MockTransport()
        retries = []
        states = []
        manager = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: transport,
            backoff: Backoff(random: { _ in 1.0 }),
            scheduleRetry: { [self] delay, block in retries.append((delay, block)) })
        manager.onStateChange = { [self] in states.append($0) }
    }

    private func handshake() {
        manager.start()
        transport.onEvent?(.opened)
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
    }

    func testHelloIsTheFirstTextSentOnOpen() throws {
        manager.start()
        XCTAssertEqual(manager.state, .connecting)
        XCTAssertEqual(transport.connects, [URL(string: "ws://127.0.0.1:8765")!])
        transport.onEvent?(.opened)
        XCTAssertEqual(manager.state, .helloSent)
        let first = try XCTUnwrap(transport.sentTexts.first)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(first.utf8)) as? NSDictionary)
        XCTAssertEqual(obj, ["v": 1, "type": "hello", "client": "senses-macos", "protocol": 1])
    }

    func testHelloAckCompletesHandshake() {
        handshake()
        XCTAssertEqual(manager.state, .connected(daemonVersion: "0.1.0"))
        XCTAssertEqual(states.last, .connected(daemonVersion: "0.1.0"))
    }

    func testDaemonMessagesForwardAfterHandshake() {
        var received: [DaemonMessage] = []
        manager.onDaemonMessage = { received.append($0) }
        handshake()
        transport.onEvent?(.text(#"{"v":1,"type":"state","mode":"listening"}"#))
        XCTAssertEqual(received, [.state(mode: .listening)])
    }

    func testTtsBinaryFramesSurfaceAsPcm() {
        var pcm: [[Int16]] = []
        manager.onTtsPcm = { pcm.append($0) }
        handshake()
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [5, -5])))
        XCTAssertEqual(pcm, [[5, -5]])
        transport.onEvent?(.data(FrameCodec.encode(.micPcm16k, pcm: [1]))) // wrong direction
        transport.onEvent?(.data(Data([0x02, 0x01])))                      // malformed
        XCTAssertEqual(pcm.count, 1)
    }

    func testSendsDropUnlessConnected() {
        manager.start()
        transport.onEvent?(.opened)
        manager.sendMicFrame([1, 2, 3])
        manager.send(.ptt(action: .down))
        XCTAssertTrue(transport.sentData.isEmpty)
        XCTAssertEqual(transport.sentTexts.count, 1) // just the hello
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
        manager.sendMicFrame([1, 2, 3])
        XCTAssertEqual(transport.sentData.count, 1)
        XCTAssertEqual(transport.sentData[0].first, 0x01)
    }

    func testCloseSchedulesBackoffRetries() {
        handshake()
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(manager.state, .disconnected)
        XCTAssertEqual(retries.count, 1)
        XCTAssertEqual(retries[0].delay, 0.5)

        retries[0].block() // retry → connect again, fails immediately
        XCTAssertEqual(transport.connects.count, 2)
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(retries[1].delay, 1.0)
    }

    func testSuccessfulHandshakeResetsBackoff() {
        handshake()
        transport.onEvent?(.closed(reason: nil))     // delay 0.5
        retries[0].block()
        transport.onEvent?(.opened)
        transport.onEvent?(.text(#"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#))
        transport.onEvent?(.closed(reason: nil))
        XCTAssertEqual(retries[1].delay, 0.5)        // reset, not 1.0
    }

    func testStopClosesWithoutRetry() {
        handshake()
        manager.stop()
        XCTAssertEqual(transport.closeCount, 1)
        transport.onEvent?(.closed(reason: nil))
        XCTAssertTrue(retries.isEmpty)
    }

    func testGarbageInboundIsDroppedSilently() {
        var received: [DaemonMessage] = []
        manager.onDaemonMessage = { received.append($0) }
        handshake()
        transport.onEvent?(.text("not json"))
        transport.onEvent?(.text(#"{"v":1,"type":"future.thing"}"#))
        XCTAssertTrue(received.isEmpty)
        XCTAssertEqual(manager.state, .connected(daemonVersion: "0.1.0"))
    }
}
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter ConnectionManagerTests`
Expected: FAIL — types not found.

- [ ] **Step 5: Implement transport protocol + manager**

`Sources/ClaurpSensesCore/Connection/WsTransport.swift`:

```swift
import Foundation

public enum WsTransportEvent: Equatable {
    case opened
    case text(String)
    case data(Data)
    case closed(reason: String?)
}

public protocol WsTransport: AnyObject {
    var onEvent: ((WsTransportEvent) -> Void)? { get set }
    func connect(url: URL)
    func send(text: String)
    func send(data: Data)
    func close()
}
```

`Sources/ClaurpSensesCore/Connection/ConnectionManager.swift`:

```swift
import Foundation

public enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case helloSent
    case connected(daemonVersion: String)
}

/// Hello-first handshake, ack gate, and backoff reconnect (spec §5).
/// Main-thread only; the transport must deliver events on main.
public final class ConnectionManager {
    private let url: URL
    private let transport: WsTransport
    private var backoff: Backoff
    private let scheduleRetry: (TimeInterval, @escaping () -> Void) -> Void
    private var stopped = false

    public private(set) var state: ConnectionState = .disconnected {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    public var onStateChange: ((ConnectionState) -> Void)?
    public var onDaemonMessage: ((DaemonMessage) -> Void)?
    public var onTtsPcm: (([Int16]) -> Void)?

    public init(url: URL,
                transport: WsTransport,
                backoff: Backoff = Backoff(),
                scheduleRetry: @escaping (TimeInterval, @escaping () -> Void) -> Void) {
        self.url = url
        self.transport = transport
        self.backoff = backoff
        self.scheduleRetry = scheduleRetry
        transport.onEvent = { [weak self] in self?.handle($0) }
    }

    public func start() {
        stopped = false
        connect()
    }

    public func stop() {
        stopped = true
        transport.close()
        state = .disconnected
    }

    public func reconnectNow() {
        guard state == .disconnected, !stopped else { return }
        backoff.reset()
        connect()
    }

    public func send(_ msg: SensesMessage) {
        guard case .connected = state, let data = try? WireCodec.encode(msg),
              let text = String(data: data, encoding: .utf8) else { return }
        transport.send(text: text)
    }

    public func sendMicFrame(_ pcm: [Int16]) {
        guard case .connected = state else { return }
        transport.send(data: FrameCodec.encode(.micPcm16k, pcm: pcm))
    }

    private func connect() {
        state = .connecting
        transport.connect(url: url)
    }

    private func handle(_ event: WsTransportEvent) {
        switch event {
        case .opened:
            if let data = try? WireCodec.encode(.hello(client: ClaurpSenses.clientName)),
               let text = String(data: data, encoding: .utf8) {
                transport.send(text: text)
            }
            state = .helloSent

        case .text(let text):
            guard let msg = try? WireCodec.decodeDaemon(Data(text.utf8)) else {
                NSLog("claurp: dropping malformed daemon message")
                return
            }
            guard let msg else {
                NSLog("claurp: dropping unknown daemon message")
                return
            }
            if case .helloSent = state {
                if case .helloAck(let version) = msg {
                    backoff.reset()
                    state = .connected(daemonVersion: version)
                }
                return // nothing else is expected before the ack
            }
            if case .connected = state {
                onDaemonMessage?(msg)
            }

        case .data(let data):
            guard case .connected = state,
                  let frame = try? FrameCodec.decode(data),
                  frame.type == BinaryFrameType.ttsPcm24k.rawValue else { return }
            onTtsPcm?(frame.pcm)

        case .closed(let reason):
            let wasStopped = stopped
            state = .disconnected
            if !wasStopped {
                let delay = backoff.next()
                NSLog("claurp: daemon connection closed (%@); retrying in %.1fs",
                      reason ?? "no reason", delay)
                scheduleRetry(delay) { [weak self] in
                    guard let self, !self.stopped, self.state == .disconnected else { return }
                    self.connect()
                }
            }
        }
    }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter ConnectionManagerTests`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): connection state machine with hello gate and backoff"
```

---

### Task 10: URLSession WebSocket transport + loopback integration test

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Connection/UrlSessionWsTransport.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/LoopbackIntegrationTests.swift`

**Interfaces:**
- Consumes: `WsTransport` (Task 9), `ConnectionManager`, `WireCodec`, `FrameCodec`.
- Produces: `final class UrlSessionWsTransport: NSObject, WsTransport` — real transport delivering events on the main queue; URLSession auto-replies to WS pings at the framework level (daemon watchdog: ping every 5 s, terminate after 3 misses).

- [ ] **Step 1: Implement the transport (integration-tested, not unit-tested)**

`Sources/ClaurpSensesCore/Connection/UrlSessionWsTransport.swift`:

```swift
import Foundation

/// URLSessionWebSocketTask-backed transport. The framework auto-replies to
/// server pings, satisfying the daemon's 5 s watchdog without client code.
/// All events are delivered on the main queue.
public final class UrlSessionWsTransport: NSObject, WsTransport, URLSessionWebSocketDelegate {
    public var onEvent: ((WsTransportEvent) -> Void)?
    private var task: URLSessionWebSocketTask?
    private var closedReported = false
    private lazy var session = URLSession(configuration: .ephemeral,
                                          delegate: self,
                                          delegateQueue: OperationQueue.main)

    public func connect(url: URL) {
        closedReported = false
        let task = session.webSocketTask(with: url)
        self.task = task
        receiveLoop(on: task)
        task.resume()
    }

    public func send(text: String) {
        task?.send(.string(text)) { _ in }
    }

    public func send(data: Data) {
        task?.send(.data(data)) { _ in }
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receiveLoop(on task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self, let task, task === self.task else { return }
            switch result {
            case .success(.string(let text)):
                self.onEvent?(.text(text))
                self.receiveLoop(on: task)
            case .success(.data(let data)):
                self.onEvent?(.data(data))
                self.receiveLoop(on: task)
            case .success:
                self.receiveLoop(on: task)
            case .failure(let error):
                self.reportClosed(reason: error.localizedDescription)
            }
        }
    }

    private func reportClosed(reason: String?) {
        guard !closedReported else { return }
        closedReported = true
        task = nil
        onEvent?(.closed(reason: reason))
    }

    // MARK: URLSessionWebSocketDelegate
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        onEvent?(.opened)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        reportClosed(reason: reason.flatMap { String(data: $0, encoding: .utf8) })
    }
}
```

- [ ] **Step 2: Write the loopback integration test**

`Tests/ClaurpSensesCoreTests/LoopbackIntegrationTests.swift`:

```swift
import XCTest
import Network
@testable import ClaurpSensesCore

/// In-process WebSocket server (Network.framework). Pings the client so the
/// test proves the real transport survives the daemon's watchdog pattern.
final class StubWsServer {
    private let listener: NWListener
    private var connection: NWConnection?
    private(set) var receivedBinary: [Data] = []
    var onText: ((String) -> Void)?
    var onBinary: ((Data) -> Void)?
    // Default-initialized so the handler closures below may capture self
    // (all stored properties must be set before self is captured).
    private(set) var port: UInt16 = 0
    // Dedicated queue: the test thread blocks on the ready semaphore, so
    // listener callbacks must NOT be scheduled on .main or init deadlocks.
    private let queue = DispatchQueue(label: "claurp.stub-ws-server")

    init() throws {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        listener = try NWListener(using: params, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = self?.listener.port?.rawValue ?? 0
                ready.signal()
            }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            self.connection = conn
            conn.start(queue: self.queue)
            self.receiveNext(on: conn)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, port != 0 else {
            throw XCTSkip("sandbox refused a loopback listener")
        }
    }

    private func receiveNext(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            if let data, let context,
               let meta = context.protocolMetadata(definition: NWProtocolWebSocket.definition)
                            as? NWProtocolWebSocket.Metadata {
                switch meta.opcode {
                case .text:
                    self.onText?(String(decoding: data, as: UTF8.self))
                case .binary:
                    self.receivedBinary.append(data)
                    self.onBinary?(data)
                default:
                    break
                }
            }
            self.receiveNext(on: conn)
        }
    }

    private func sendFrame(_ data: Data, opcode: NWProtocolWebSocket.Opcode) {
        let meta = NWProtocolWebSocket.Metadata(opcode: opcode)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
        connection?.send(content: data, contentContext: context,
                         isComplete: true, completion: .contentProcessed { _ in })
    }

    func send(text: String) { sendFrame(Data(text.utf8), opcode: .text) }
    func send(binary: Data) { sendFrame(binary, opcode: .binary) }
    func ping() { sendFrame(Data(), opcode: .ping) }
    func stop() {
        connection?.cancel()
        listener.cancel()
    }
}

final class LoopbackIntegrationTests: XCTestCase {
    func testHandshakeFramesAndWatchdogSurvival() throws {
        let server = try StubWsServer()
        defer { server.stop() }

        let helloReceived = expectation(description: "server got hello")
        var helloWasFirst = false
        var textCount = 0
        server.onText = { text in
            textCount += 1
            if textCount == 1, text.contains("\"type\":\"hello\"") || text.contains("\"hello\"") {
                helloWasFirst = true
                server.send(text: #"{"v":1,"type":"hello.ack","daemonVersion":"0.1.0"}"#)
                helloReceived.fulfill()
            }
        }

        let manager = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:\(server.port)")!,
            transport: UrlSessionWsTransport(),
            scheduleRetry: { delay, block in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            })
        let connected = expectation(description: "connected")
        var sawDisconnect = false
        manager.onStateChange = { state in
            if case .connected = state { connected.fulfill() }
            if state == .disconnected { sawDisconnect = true }
        }
        var ttsPcm: [[Int16]] = []
        let gotTts = expectation(description: "tts frame")
        manager.onTtsPcm = { pcm in
            ttsPcm.append(pcm)
            gotTts.fulfill()
        }
        manager.start()
        wait(for: [helloReceived, connected], timeout: 5)
        XCTAssertTrue(helloWasFirst)

        // Binary both directions.
        server.send(binary: FrameCodec.encode(.ttsPcm24k, pcm: [9, -9]))
        wait(for: [gotTts], timeout: 5)
        XCTAssertEqual(ttsPcm, [[9, -9]])

        let gotMic = expectation(description: "mic frame")
        server.onBinary = { data in
            if data.first == 0x01 { gotMic.fulfill() }
        }
        manager.sendMicFrame([1, 2, 3])
        wait(for: [gotMic], timeout: 5)

        // Watchdog pattern: several server pings; connection must stay up
        // (URLSession auto-pongs) and traffic must still flow afterwards.
        for i in 0..<3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.3) { server.ping() }
        }
        let stillAlive = expectation(description: "message after pings")
        var sawPostPingState = false
        manager.onDaemonMessage = { msg in
            if msg == .state(mode: .listening), !sawPostPingState {
                sawPostPingState = true
                stillAlive.fulfill()
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            server.send(text: #"{"v":1,"type":"state","mode":"listening"}"#)
        }
        wait(for: [stillAlive], timeout: 5)
        XCTAssertFalse(sawDisconnect)
        manager.stop()
    }
}
```

- [ ] **Step 3: Run the integration test**

Run: `swift test --package-path apps/senses-macos --filter LoopbackIntegrationTests`
Expected: PASS (or SKIP if the environment forbids loopback listeners). If Network.framework's WS metadata API differs, adapt the stub server only — the assertions (hello first, both binary directions, survival past pings) stay.

- [ ] **Step 4: Full run + commit**

Run: `swift test --package-path apps/senses-macos` — Expected: all PASS.

```bash
git add apps/senses-macos
git commit -m "feat(senses): URLSession WS transport with loopback integration test"
```

---

### Task 11: HUD state + reducer

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Hud/HudState.swift`
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/Hud/HudReducer.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/HudReducerTests.swift`

**Interfaces:**
- Consumes: `DaemonMessage`, `ConnectionState`, `StateMode`, `HudPermission`.
- Produces:
  - `struct HudState: Equatable { var mode: StateMode = .disconnected; var paused = false; var offline = true; var transcript = ""; var transcriptIsFinal = false; var sessionId = ""; var sessionLabel = ""; var narration = ""; var permission: HudPermission? = nil; var pill: Pill { get } }` with `enum Pill: Equatable { case hidden, listening(transcript: String), working(label: String, narration: String), permission(HudPermission), offline }`
  - `enum HudEvent: Equatable { case daemon(DaemonMessage), connection(ConnectionState), pause(Bool), permissionResolved }`
  - `enum HudReducer { static func reduce(_ state: HudState, _ event: HudEvent) -> HudState }` (pure).
- Rules (spec §4.2): transcript resets when `state.mode` actually changes; `transcript.final` holds until the next mode change; `hud.session` narration `nil` keeps the previous narration for the same session, resets it for a new `sessionId`; permission card clears on mode change away from `needs-you` and on `permissionResolved`; offline clears the card and forces `.offline` pill.

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/HudReducerTests.swift`:

```swift
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter HudReducerTests`
Expected: FAIL.

- [ ] **Step 3: Implement**

`Sources/ClaurpSensesCore/Hud/HudState.swift`:

```swift
public struct HudState: Equatable {
    public var mode: StateMode = .disconnected
    public var paused = false
    public var offline = true
    public var transcript = ""
    public var transcriptIsFinal = false
    public var sessionId = ""
    public var sessionLabel = ""
    public var narration = ""
    public var permission: HudPermission? = nil

    public init() {}

    public enum Pill: Equatable {
        case hidden
        case listening(transcript: String)
        case working(label: String, narration: String)
        case permission(HudPermission)
        case offline
    }

    /// Derived pill content (spec §4.2 table).
    public var pill: Pill {
        if offline { return .offline }
        switch mode {
        case .idle, .disconnected:
            return .hidden
        case .listening:
            return .listening(transcript: transcript)
        case .working:
            return .working(label: sessionLabel, narration: narration)
        case .needsYou:
            if let permission { return .permission(permission) }
            return .working(label: sessionLabel, narration: narration)
        }
    }
}
```

`Sources/ClaurpSensesCore/Hud/HudReducer.swift`:

```swift
public enum HudEvent: Equatable {
    case daemon(DaemonMessage)
    case connection(ConnectionState)
    case pause(Bool)
    case permissionResolved
}

public enum HudReducer {
    public static func reduce(_ state: HudState, _ event: HudEvent) -> HudState {
        var s = state
        switch event {
        case .connection(let conn):
            if case .connected = conn {
                s.offline = false
            } else {
                s.offline = true
                s.mode = .disconnected
                s.permission = nil
            }

        case .pause(let paused):
            s.paused = paused

        case .permissionResolved:
            s.permission = nil

        case .daemon(let msg):
            switch msg {
            case .state(let mode):
                if mode != s.mode {
                    s.transcript = ""
                    s.transcriptIsFinal = false
                }
                s.mode = mode
                if mode != .needsYou {
                    s.permission = nil
                }
            case .transcriptPartial(let text):
                s.transcript = text
                s.transcriptIsFinal = false
            case .transcriptFinal(let text):
                s.transcript = text
                s.transcriptIsFinal = true
            case .hudSession(let session):
                if session.sessionId != s.sessionId {
                    s.narration = ""
                }
                s.sessionId = session.sessionId
                s.sessionLabel = session.label
                if let narration = session.narration {
                    s.narration = narration
                }
            case .hudPermission(let card):
                s.permission = card
            case .helloAck, .earcon, .notify, .speakStop:
                break // handled elsewhere (controller / earcons / notifications)
            }
        }
        return s
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter HudReducerTests`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): pure HUD reducer and pill derivation"
```

---

### Task 12: SensesController orchestration

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSensesCore/SensesController.swift`
- Test: `apps/senses-macos/Tests/ClaurpSensesCoreTests/SensesControllerTests.swift`

**Interfaces:**
- Consumes: `ConnectionManager` (Task 9, driven in tests via `MockTransport`), `MicCaptureType` (Task 7), `TtsPlaybackController` + `PcmScheduler` (Task 8), `HudReducer`/`HudState` (Task 11).
- Produces:
  - `protocol EarconPlayerType: AnyObject { func play(_ kind: EarconKind) }`
  - `protocol NotificationPresenterType: AnyObject { func present(_ notify: NotifyPayload) }`
  - `final class SensesController { init(connection: ConnectionManager, mic: MicCaptureType, playback: TtsPlaybackController, earcons: EarconPlayerType, notifier: NotificationPresenterType); private(set) var hud: HudState; var onHudChange: ((HudState) -> Void)?; func start(); func setPaused(_ paused: Bool); func pttDown(); func pttUp(); func respond(sessionId: String, requestId: String, decision: PermissionDecision); func reconnectNow(); func quit() }`
- Behavior: routes every daemon message into the reducer; `speak.stop` AND `earcon(wake-ack)` → `playback.bargeIn()` (barge-in **before** playing the wake earcon); `earcon` → player; `notify` → presenter; TTS pcm → playback; mic chunks → `connection.sendMicFrame`; pause stops/starts the mic engine and updates HUD; respond sends `permission.response` and dispatches `.permissionResolved`.

- [ ] **Step 1: Write the failing tests**

`Tests/ClaurpSensesCoreTests/SensesControllerTests.swift`:

```swift
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
    func play(_ kind: EarconKind) { played.append(kind) }
}

final class MockNotifier: NotificationPresenterType {
    var presented: [NotifyPayload] = []
    func present(_ notify: NotifyPayload) { presented.append(notify) }
}

final class SensesControllerTests: XCTestCase {
    var transport: MockTransport!
    var mic: MockMic!
    var scheduler: MockScheduler!
    var earcons: MockEarcons!
    var notifier: MockNotifier!
    var controller: SensesController!

    override func setUp() {
        super.setUp()
        transport = MockTransport()
        mic = MockMic()
        scheduler = MockScheduler()
        earcons = MockEarcons()
        notifier = MockNotifier()
        let connection = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: transport,
            backoff: Backoff(random: { _ in 1.0 }),
            scheduleRetry: { _, _ in })
        controller = SensesController(
            connection: connection,
            mic: mic,
            playback: TtsPlaybackController(scheduler: scheduler, prerollSamples: 100),
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
        XCTAssertEqual(scheduler.started, 1)
        daemon(#"{"v":1,"type":"speak.stop"}"#)
        XCTAssertEqual(scheduler.flushed, 1)
    }

    func testWakeAckEarconBargesInAndPlays() {
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        daemon(#"{"v":1,"type":"earcon","kind":"wake-ack"}"#)
        XCTAssertEqual(scheduler.flushed, 1)
        XCTAssertEqual(earcons.played, [.wakeAck])
    }

    func testNonWakeEarconPlaysWithoutBargeIn() {
        transport.onEvent?(.data(FrameCodec.encode(.ttsPcm24k, pcm: [Int16](repeating: 0, count: 200))))
        daemon(#"{"v":1,"type":"earcon","kind":"done"}"#)
        XCTAssertEqual(scheduler.flushed, 0)
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

    func testPttSendsDownAndUp() {
        controller.pttDown()
        controller.pttUp()
        XCTAssertTrue(transport.sentTexts.contains { $0.contains("\"action\":\"down\"") })
        XCTAssertTrue(transport.sentTexts.contains { $0.contains("\"action\":\"up\"") })
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path apps/senses-macos --filter SensesControllerTests`
Expected: FAIL.

- [ ] **Step 3: Implement**

`Sources/ClaurpSensesCore/SensesController.swift`:

```swift
import Foundation

public protocol EarconPlayerType: AnyObject {
    func play(_ kind: EarconKind)
}

public protocol NotificationPresenterType: AnyObject {
    func present(_ notify: NotifyPayload)
}

/// Wires connection ↔ audio ↔ HUD. Main-thread only.
public final class SensesController {
    private let connection: ConnectionManager
    private let mic: MicCaptureType
    private let playback: TtsPlaybackController
    private let earcons: EarconPlayerType
    private let notifier: NotificationPresenterType

    public private(set) var hud = HudState()
    public var onHudChange: ((HudState) -> Void)?

    public init(connection: ConnectionManager,
                mic: MicCaptureType,
                playback: TtsPlaybackController,
                earcons: EarconPlayerType,
                notifier: NotificationPresenterType) {
        self.connection = connection
        self.mic = mic
        self.playback = playback
        self.earcons = earcons
        self.notifier = notifier
    }

    public func start() {
        connection.onStateChange = { [weak self] state in
            self?.dispatch(.connection(state))
        }
        connection.onDaemonMessage = { [weak self] msg in
            self?.handle(msg)
        }
        connection.onTtsPcm = { [weak self] pcm in
            self?.playback.receive(pcm)
        }
        mic.onChunk = { [weak self] chunk in
            self?.connection.sendMicFrame(chunk)
        }
        connection.start()
        startMicIfNeeded()
    }

    public func setPaused(_ paused: Bool) {
        if paused {
            mic.stop()
        } else {
            startMicIfNeeded()
        }
        dispatch(.pause(paused))
    }

    public func pttDown() { connection.send(.ptt(action: .down)) }
    public func pttUp() { connection.send(.ptt(action: .up)) }

    public func respond(sessionId: String, requestId: String, decision: PermissionDecision) {
        connection.send(.permissionResponse(sessionId: sessionId,
                                            requestId: requestId,
                                            decision: decision))
        dispatch(.permissionResolved)
    }

    public func reconnectNow() { connection.reconnectNow() }

    public func quit() {
        mic.stop()
        playback.bargeIn()
        connection.stop()
    }

    private func startMicIfNeeded() {
        guard !mic.isRunning else { return }
        do {
            try mic.start()
        } catch {
            NSLog("claurp: mic start failed: %@", error.localizedDescription)
        }
    }

    private func handle(_ msg: DaemonMessage) {
        switch msg {
        case .speakStop:
            playback.bargeIn()
        case .earcon(let kind):
            if kind == .wakeAck {
                playback.bargeIn() // never talk over the user (spec §3.2)
            }
            earcons.play(kind)
        case .notify(let payload):
            notifier.present(payload)
        default:
            break
        }
        dispatch(.daemon(msg))
    }

    private func dispatch(_ event: HudEvent) {
        let next = HudReducer.reduce(hud, event)
        guard next != hud else { return }
        hud = next
        onHudChange?(next)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path apps/senses-macos --filter SensesControllerTests`
Expected: PASS (10 tests). Then full run: `swift test --package-path apps/senses-macos` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): SensesController orchestration with wake barge-in"
```

---

### Task 13: App target — XcodeGen project, AppDelegate, menu-bar status item

**Files:**
- Create: `apps/senses-macos/project.yml`
- Create: `apps/senses-macos/Sources/ClaurpSenses/main.swift`
- Create: `apps/senses-macos/Sources/ClaurpSenses/AppDelegate.swift`
- Create: `apps/senses-macos/Sources/ClaurpSenses/StatusIcon.swift`

**Interfaces:**
- Consumes: everything in `ClaurpSensesCore`.
- Produces: a buildable `ClaurpSenses.app` (menu-bar only) that connects, streams mic, plays TTS, and shows state in the status item. Temporary no-op earcons/notifier (replaced in Task 15). `AppDelegate` exposes `controller: SensesController` and `func hudChanged(_ hud: HudState)` extension points that Tasks 14–16 build on.

No unit tests — this target is the thin shell; `xcodebuild build` is the check, and Task 17's smoke exercises it live.

- [ ] **Step 1: Ensure XcodeGen is available**

XcodeGen is a dev-machine tool. If `which xcodegen` is empty, ask your human partner to run `! brew install xcodegen` (project safety rules: no unprompted global installs).

- [ ] **Step 2: Write `project.yml`**

```yaml
name: ClaurpSenses
options:
  bundleIdPrefix: dev.claurp
  deploymentTarget:
    macOS: "14.0"
packages:
  ClaurpSensesCore:
    path: .
targets:
  ClaurpSenses:
    type: application
    platform: macOS
    sources:
      - path: Sources/ClaurpSenses
      - path: Resources
        buildPhase: resources
        optional: true
    dependencies:
      - package: ClaurpSensesCore
        product: ClaurpSensesCore
    info:
      path: Sources/ClaurpSenses/Info.plist
      properties:
        CFBundleDisplayName: claurp
        LSUIElement: true
        NSMicrophoneUsageDescription: >-
          claurp streams your microphone to the local claurp daemon so the
          "hey claude" wake word works. Audio never leaves this Mac.
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: dev.claurp.senses
        CODE_SIGN_IDENTITY: "-"
        SWIFT_VERSION: "5.9"
```

If Xcode refuses a local package at `path: .` (same dir as the generated project), move the app shell to an `App/` subdirectory with `path: ..` — config-only change; source layout of `ClaurpSensesCore` must not move.

- [ ] **Step 3: Write the shell**

`Sources/ClaurpSenses/main.swift`:

```swift
import AppKit

let delegate = AppDelegate()
NSApplication.shared.delegate = delegate
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
```

`Sources/ClaurpSenses/StatusIcon.swift`:

```swift
import AppKit
import ClaurpSensesCore

enum StatusIcon {
    /// SF Symbol per HUD condition; template images track the menu-bar tint.
    static func image(for hud: HudState) -> NSImage? {
        let name: String
        if hud.offline {
            name = "bolt.slash"
        } else if hud.paused {
            name = "pause.circle"
        } else {
            switch hud.mode {
            case .idle, .disconnected: name = "waveform.circle"
            case .listening: name = "waveform"
            case .working: name = "hourglass"
            case .needsYou: name = "exclamationmark.bubble"
            }
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "claurp")
        image?.isTemplate = true
        return image
    }
}
```

`Sources/ClaurpSenses/AppDelegate.swift`:

```swift
import AppKit
import AVFoundation
import ClaurpSensesCore

// Replaced by real implementations in Task 15.
final class NoopEarcons: EarconPlayerType {
    func play(_ kind: EarconKind) {}
}
final class NoopNotifier: NotificationPresenterType {
    func present(_ notify: NotifyPayload) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var controller: SensesController!
    private var statusItem: NSStatusItem!
    private var pauseItem: NSMenuItem!
    private var reconnectItem: NSMenuItem!
    private var micDeniedItem: NSMenuItem!
    private var paused = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let connection = ConnectionManager(
            url: URL(string: "ws://127.0.0.1:8765")!,
            transport: UrlSessionWsTransport(),
            scheduleRetry: { delay, block in
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: block)
            })
        controller = SensesController(
            connection: connection,
            mic: MicCaptureEngine(),
            playback: TtsPlaybackController(scheduler: EnginePcmScheduler()),
            earcons: NoopEarcons(),
            notifier: NoopNotifier())

        setUpStatusItem()
        controller.onHudChange = { [weak self] hud in self?.hudChanged(hud) }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                self?.micDeniedItem.isHidden = granted
                self?.controller.start()
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.quit()
    }

    /// Tasks 14–16 extend this (pill panel, etc.).
    func hudChanged(_ hud: HudState) {
        statusItem.button?.image = StatusIcon.image(for: hud)
        reconnectItem.isHidden = !hud.offline
    }

    private func setUpStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = StatusIcon.image(for: controller.hud)

        let menu = NSMenu()
        pauseItem = NSMenuItem(title: "Pause Listening",
                               action: #selector(togglePause), keyEquivalent: "")
        pauseItem.target = self
        menu.addItem(pauseItem)

        reconnectItem = NSMenuItem(title: "Reconnect Now",
                                   action: #selector(reconnect), keyEquivalent: "")
        reconnectItem.target = self
        menu.addItem(reconnectItem)

        micDeniedItem = NSMenuItem(title: "Microphone Access Denied — Open Settings…",
                                   action: #selector(openMicSettings), keyEquivalent: "")
        micDeniedItem.target = self
        micDeniedItem.isHidden = true
        menu.addItem(micDeniedItem)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit claurp", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc private func togglePause() {
        paused.toggle()
        controller.setPaused(paused)
        pauseItem.title = paused ? "Resume Listening" : "Pause Listening"
    }

    @objc private func reconnect() {
        controller.reconnectNow()
    }

    @objc private func openMicSettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")!
        NSWorkspace.shared.open(url)
    }

    @objc private func quitApp() {
        controller.quit()
        NSApp.terminate(nil)
    }
}
```

- [ ] **Step 4: Generate + build**

```bash
cd apps/senses-macos
xcodegen generate
xcodebuild -project ClaurpSenses.xcodeproj -scheme ClaurpSenses -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: BUILD SUCCEEDED. (`swift test --package-path .` must also still pass.)

- [ ] **Step 5: Optional local run**

`open` the built app from DerivedData (path printed by xcodebuild) with the daemon down: menu-bar icon shows `bolt.slash`; menu shows Reconnect Now; Quit works.

- [ ] **Step 6: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): menu-bar app shell via XcodeGen"
```

---

### Task 14: Floating pill panel (SwiftUI)

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSenses/HudStore.swift`
- Create: `apps/senses-macos/Sources/ClaurpSenses/PillPanel.swift`
- Create: `apps/senses-macos/Sources/ClaurpSenses/PillView.swift`
- Modify: `apps/senses-macos/Sources/ClaurpSenses/AppDelegate.swift` (wire pill into `hudChanged`)

**Interfaces:**
- Consumes: `HudState`/`Pill` (Task 11), `SensesController.respond` (Task 12).
- Produces: a non-activating floating `NSPanel` at `.floating` level, all Spaces, draggable with `setFrameAutosaveName("ClaurpPill")`; content per `HudState.pill`; offline chip auto-hides after 4 s (view-layer timer — the reducer stays pure).

No unit tests (the pill renders reducer output already covered by Task 11); `xcodebuild build` + Task 17 smoke.

- [ ] **Step 1: Write the store and panel**

`Sources/ClaurpSenses/HudStore.swift`:

```swift
import Combine
import ClaurpSensesCore

final class HudStore: ObservableObject {
    @Published var state = HudState()
}
```

`Sources/ClaurpSenses/PillPanel.swift`:

```swift
import AppKit
import SwiftUI
import ClaurpSensesCore

final class PillPanel: NSPanel {
    private let hosting: NSHostingView<PillView>

    init(store: HudStore, respond: @escaping (HudPermission, PermissionDecision) -> Void) {
        hosting = NSHostingView(rootView: PillView(store: store, respond: respond))
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 64),
                   styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        isMovableByWindowBackground = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        contentView = hosting
        setFrameAutosaveName("ClaurpPill")
        if frameAutosaveName.isEmpty || !setFrameUsingName("ClaurpPill") {
            positionTopRight()
        }
    }

    func refreshSize() {
        setContentSize(hosting.fittingSize)
    }

    private func positionTopRight() {
        guard let screen = NSScreen.main else { return }
        let f = screen.visibleFrame
        setFrameOrigin(NSPoint(x: f.maxX - frame.width - 24, y: f.maxY - frame.height - 24))
    }
}
```

- [ ] **Step 2: Write the view**

`Sources/ClaurpSenses/PillView.swift`:

```swift
import SwiftUI
import ClaurpSensesCore

struct PillView: View {
    @ObservedObject var store: HudStore
    let respond: (HudPermission, PermissionDecision) -> Void

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(width: 360, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private var content: some View {
        switch store.state.pill {
        case .hidden:
            EmptyView()
        case .listening(let transcript):
            HStack(spacing: 8) {
                Image(systemName: "waveform")
                Text(transcript.isEmpty ? "Listening…" : transcript)
                    .lineLimit(2)
                    .font(.callout)
            }
        case .working(let label, let narration):
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.callout.bold())
                if !narration.isEmpty {
                    Text(narration).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        case .permission(let card):
            VStack(alignment: .leading, spacing: 6) {
                Text("\(card.tool) needs permission").font(.callout.bold())
                Text(card.detail).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                HStack {
                    Button("Allow") { respond(card, .allow) }
                        .keyboardShortcut(.defaultAction)
                    Button("Deny") { respond(card, .deny) }
                }
            }
        case .offline:
            HStack(spacing: 8) {
                Image(systemName: "bolt.slash")
                Text("claurp offline").font(.callout)
            }
        }
    }
}
```

- [ ] **Step 3: Wire into AppDelegate**

In `AppDelegate`, add properties:

```swift
    private let hudStore = HudStore()
    private var pillPanel: PillPanel!
    private var offlineHideTimer: Timer?
```

In `applicationDidFinishLaunching`, after `setUpStatusItem()`:

```swift
        pillPanel = PillPanel(store: hudStore) { [weak self] card, decision in
            self?.controller.respond(sessionId: card.sessionId,
                                     requestId: card.requestId,
                                     decision: decision)
        }
```

Extend `hudChanged(_:)`:

```swift
    func hudChanged(_ hud: HudState) {
        statusItem.button?.image = StatusIcon.image(for: hud)
        reconnectItem.isHidden = !hud.offline
        hudStore.state = hud
        offlineHideTimer?.invalidate()
        switch hud.pill {
        case .hidden:
            pillPanel.orderOut(nil)
        case .offline:
            pillPanel.refreshSize()
            pillPanel.orderFrontRegardless()
            // Offline chip auto-hides; the status icon keeps the persistent signal.
            offlineHideTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
                self?.pillPanel.orderOut(nil)
            }
        default:
            pillPanel.refreshSize()
            pillPanel.orderFrontRegardless()
        }
    }
```

- [ ] **Step 4: Build + verify**

```bash
cd apps/senses-macos && xcodegen generate && \
xcodebuild -project ClaurpSenses.xcodeproj -scheme ClaurpSenses -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: BUILD SUCCEEDED; `swift test --package-path apps/senses-macos` still all-PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/senses-macos
git commit -m "feat(senses): floating HUD pill with permission card"
```

---

### Task 15: Earcons + native notifications with Allow/Deny

**Files:**
- Create: `apps/senses-macos/scripts/gen-earcons.swift`
- Create (generated, committed): `apps/senses-macos/Resources/Earcons/{wake-ack,shutter,permission-ask,done}.wav`
- Create: `apps/senses-macos/Sources/ClaurpSenses/EarconPlayer.swift`
- Create: `apps/senses-macos/Sources/ClaurpSenses/NotificationPresenter.swift`
- Modify: `apps/senses-macos/Sources/ClaurpSenses/AppDelegate.swift` (replace the Noop implementations)

**Interfaces:**
- Consumes: `EarconPlayerType`, `NotificationPresenterType`, `NotifyPayload`, `PermissionDecision` (Task 12).
- Produces: `EarconPlayer` (AVAudioPlayer, preloaded per kind) and `NotificationPresenter` (UNUserNotificationCenter, category `CLAURP_PERMISSION` with Allow/Deny actions, `onDecision` callback). `open-terminal` actions are **not** rendered (spec §2 gap).

- [ ] **Step 1: Write and run the earcon generator (one-off; output committed)**

`apps/senses-macos/scripts/gen-earcons.swift`:

```swift
// One-off earcon synthesizer. Run from apps/senses-macos:
//   swift scripts/gen-earcons.swift
// Writes 4 short WAVs to Resources/Earcons/. Committed output; re-run only
// if you intentionally change the sounds.
import Foundation

let rate = 24000

func tone(_ segments: [(freq: Double, seconds: Double)]) -> [Int16] {
    var out: [Int16] = []
    for seg in segments {
        let n = Int(Double(rate) * seg.seconds)
        let fade = min(n / 8, Int(0.005 * Double(rate))) // 5 ms fade in/out
        for i in 0..<n {
            var amp = 0.35
            if i < fade { amp *= Double(i) / Double(fade) }
            if i >= n - fade { amp *= Double(n - i) / Double(fade) }
            let sample = seg.freq == 0 ? 0.0
                : amp * sin(2.0 * .pi * seg.freq * Double(i) / Double(rate))
            out.append(Int16(sample * 32767.0))
        }
    }
    return out
}

func wavData(_ samples: [Int16]) -> Data {
    var d = Data()
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    let byteCount = UInt32(samples.count * 2)
    d.append(contentsOf: Array("RIFF".utf8)); le32(36 + byteCount)
    d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); le32(16)
    le16(1); le16(1); le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16)
    d.append(contentsOf: Array("data".utf8)); le32(byteCount)
    for s in samples { le16(UInt16(bitPattern: s)) }
    return d
}

let earcons: [String: [(freq: Double, seconds: Double)]] = [
    "wake-ack": [(880, 0.07), (1320, 0.09)],
    "shutter": [(1200, 0.04), (500, 0.06)],
    "permission-ask": [(660, 0.09), (0, 0.03), (880, 0.12)],
    "done": [(1040, 0.07), (780, 0.12)],
]

let outDir = URL(fileURLWithPath: "Resources/Earcons", isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
for (name, segments) in earcons {
    let url = outDir.appendingPathComponent("\(name).wav")
    try wavData(tone(segments)).write(to: url)
    print("wrote \(url.path)")
}
```

Run: `cd apps/senses-macos && swift scripts/gen-earcons.swift`
Expected: 4 `.wav` files in `Resources/Earcons/` (each a few KB). Spot-check one: `afplay Resources/Earcons/wake-ack.wav`.

- [ ] **Step 2: Implement the earcon player**

`Sources/ClaurpSenses/EarconPlayer.swift`:

```swift
import AVFoundation
import ClaurpSensesCore

/// Preloads all four earcons so play() is low-latency.
final class EarconPlayer: EarconPlayerType {
    private var players: [EarconKind: AVAudioPlayer] = [:]

    init() {
        for kind in [EarconKind.wakeAck, .shutter, .permissionAsk, .done] {
            if let url = Bundle.main.url(forResource: kind.rawValue, withExtension: "wav"),
               let player = try? AVAudioPlayer(contentsOf: url) {
                player.prepareToPlay()
                players[kind] = player
            }
        }
    }

    func play(_ kind: EarconKind) {
        guard let player = players[kind] else { return }
        player.currentTime = 0
        player.play()
    }
}
```

- [ ] **Step 3: Implement the notification presenter**

`Sources/ClaurpSenses/NotificationPresenter.swift`:

```swift
import UserNotifications
import ClaurpSensesCore

/// notify → UNUserNotificationCenter. Permission notifies (sessionId +
/// requestId + allow/deny actions) get actionable buttons; `open-terminal`
/// is not rendered (spec §2: no wire path back yet).
final class NotificationPresenter: NSObject, NotificationPresenterType,
                                   UNUserNotificationCenterDelegate {
    static let categoryId = "CLAURP_PERMISSION"
    var onDecision: ((_ sessionId: String, _ requestId: String, _ decision: PermissionDecision) -> Void)?

    func setUp() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(identifier: "ALLOW", title: "Allow")
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny",
                                        options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.categoryId,
                                   actions: [allow, deny],
                                   intentIdentifiers: [])
        ])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func present(_ notify: NotifyPayload) {
        let content = UNMutableNotificationContent()
        content.title = notify.title
        content.body = notify.body
        if let sessionId = notify.sessionId, let requestId = notify.requestId,
           notify.actions.contains(.allow), notify.actions.contains(.deny) {
            content.categoryIdentifier = Self.categoryId
            content.userInfo = ["sessionId": sessionId, "requestId": requestId]
        }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString,
                                  content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard let sessionId = info["sessionId"] as? String,
              let requestId = info["requestId"] as? String else { return }
        switch response.actionIdentifier {
        case "ALLOW": onDecision?(sessionId, requestId, .allow)
        case "DENY": onDecision?(sessionId, requestId, .deny)
        default: break
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
```

- [ ] **Step 4: Replace the Noops in AppDelegate**

Delete `NoopEarcons`/`NoopNotifier`. In `applicationDidFinishLaunching`, before constructing the controller:

```swift
        let notifier = NotificationPresenter()
        notifier.setUp()
```

Construct the controller with `earcons: EarconPlayer(), notifier: notifier`, and after `controller` is set:

```swift
        notifier.onDecision = { [weak self] sessionId, requestId, decision in
            DispatchQueue.main.async {
                self?.controller.respond(sessionId: sessionId,
                                         requestId: requestId,
                                         decision: decision)
            }
        }
```

- [ ] **Step 5: Build + manual verify + commit**

```bash
cd apps/senses-macos && xcodegen generate && \
xcodebuild -project ClaurpSenses.xcodeproj -scheme ClaurpSenses -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: BUILD SUCCEEDED; the built app bundle contains `Resources/…/*.wav` (check with `find` in the DerivedData product). Full `swift test` still green.

```bash
git add apps/senses-macos
git commit -m "feat(senses): earcons and actionable permission notifications"
```

---

### Task 16: Global PTT hotkey (Carbon)

**Files:**
- Create: `apps/senses-macos/Sources/ClaurpSenses/PttHotKey.swift`
- Modify: `apps/senses-macos/Sources/ClaurpSenses/AppDelegate.swift`

**Interfaces:**
- Consumes: `SensesController.pttDown()/pttUp()` (Task 12).
- Produces: hold-to-talk ⌥Space via `RegisterEventHotKey` (no Accessibility/Input-Monitoring permission needed). UserDefaults overrides: `pttKeyCode` (Int), `pttModifiers` (Int, Carbon modifier mask) — no UI (spec §3.3).

- [ ] **Step 1: Implement**

`Sources/ClaurpSenses/PttHotKey.swift`:

```swift
import Carbon.HIToolbox
import Foundation

/// Global hold-to-talk hotkey. Default ⌥Space; override via UserDefaults
/// pttKeyCode / pttModifiers (Carbon virtual key code + modifier mask).
final class PttHotKey {
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    func register() {
        let defaults = UserDefaults.standard
        let keyCode = UInt32(defaults.object(forKey: "pttKeyCode") as? Int ?? kVK_Space)
        let modifiers = UInt32(defaults.object(forKey: "pttModifiers") as? Int ?? optionKey)

        var eventTypes = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                          eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                          eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let userData, let event else { return noErr }
            let hotKey = Unmanaged<PttHotKey>.fromOpaque(userData).takeUnretainedValue()
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) {
                hotKey.onDown?()
            } else {
                hotKey.onUp?()
            }
            return noErr
        }, 2, &eventTypes, Unmanaged.passUnretained(self).toOpaque(), &handlerRef)

        let hotKeyID = EventHotKeyID(signature: OSType(0x434C_5250) /* "CLRP" */, id: 1)
        RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    deinit {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
    }
}
```

- [ ] **Step 2: Wire into AppDelegate**

Add property `private let pttHotKey = PttHotKey()`. In `applicationDidFinishLaunching`, after `controller` is constructed:

```swift
        pttHotKey.onDown = { [weak self] in self?.controller.pttDown() }
        pttHotKey.onUp = { [weak self] in self?.controller.pttUp() }
        pttHotKey.register()
```

- [ ] **Step 3: Build + commit**

```bash
cd apps/senses-macos && xcodegen generate && \
xcodebuild -project ClaurpSenses.xcodeproj -scheme ClaurpSenses -configuration Debug build CODE_SIGNING_ALLOWED=NO
```
Expected: BUILD SUCCEEDED.

```bash
git add apps/senses-macos
git commit -m "feat(senses): global option-space push-to-talk hotkey"
```

---

### Task 17: macOS CI job + end-to-end smoke against the real daemon

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the whole plan.
- Produces: CI runs `swift test` + an app-target build on macOS on every push/PR; a manual smoke checklist proves the live loop.

- [ ] **Step 1: Add the macOS job**

Append to `jobs:` in `.github/workflows/ci.yml`:

```yaml
  senses:
    name: senses (swift test · app build)
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Swift tests
        run: swift test --package-path apps/senses-macos

      - name: Install XcodeGen
        run: brew install xcodegen

      - name: Generate Xcode project
        run: xcodegen generate --spec apps/senses-macos/project.yml --project apps/senses-macos

      - name: Build app (unsigned)
        run: >
          xcodebuild -project apps/senses-macos/ClaurpSenses.xcodeproj
          -scheme ClaurpSenses -configuration Debug build
          CODE_SIGNING_ALLOWED=NO
```

- [ ] **Step 2: Manual end-to-end smoke (dev machine, real daemon)**

Prereqs: models installed once via `pnpm --filter @claurp/daemon models`; repo built via `pnpm -r build`.

1. Start the daemon: `node packages/daemon/dist/cli.js`.
2. Launch the built `ClaurpSenses.app`.
3. Verify, in order:
   - [ ] Status icon leaves `bolt.slash` within ~1 s of daemon start (backoff reconnect works the other way too: kill + restart the daemon and watch offline → online).
   - [ ] Say "hey claude, …": wake earcon plays; pill appears with live transcript; partials overwrite in place.
   - [ ] Narration TTS plays without gaps or stutter.
   - [ ] Saying the wake word mid-TTS cuts playback instantly (barge-in).
   - [ ] A risky request produces the permission card; **Allow** in the pill resolves it; a notification with Allow/Deny appears and its buttons work too.
   - [ ] Pause Listening: macOS mic indicator turns off; wake word stops working; Resume restores it.
   - [ ] Hold ⌥Space, speak, release: `ptt` round-trip works (daemon treats it as listening).
   - [ ] Quit: app exits cleanly; daemon logs the disconnect.

Record any failures as bugs; do not ship with an unchecked box.

- [ ] **Step 3: Commit, then integrate via PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: macOS job for senses swift tests and app build"
```

Integration is by PR (standing user decision). Pushing a branch is a network action — confirm with your human partner before `git push`, then open the PR and **verify both CI jobs actually ran and passed** (Plan 1 lesson: check the run itself, e.g. `gh pr checks`, not a wrapper's exit code).

---

## Self-review (completed at plan-writing time)

- **Spec coverage:** §1 modules → Tasks 1/13; §2 mirror + tolerance → Tasks 3/5; §3.1 capture/pause → Tasks 6/7/13; §3.2 playback/barge-in → Tasks 8/12; §3.3 PTT → Tasks 12/16; §4.1 menu bar → Task 13; §4.2 pill → Tasks 11/14; §4.3 earcons/notifications → Task 15; §5 connection → Tasks 9/10; §6.1 fixtures → Tasks 4/5; §6.2 units → Tasks 2/3/6/7/8/9/11/12; §6.3 integration + CI → Tasks 10/17; §7 recorded decision → no task (daemon-side, out of scope); §8 non-goals → nothing here builds them.
- **Known intentional deviations:** resampler length asserted within ±64 samples (AVAudioConverter priming latency), not "exact"; pre-roll re-arms after barge-in but not after natural drain (documented in Task 8 code comment).
- **Type consistency:** interfaces blocks in Tasks 2/3/7/8/9/11/12 are the single source for cross-task names; later tasks reference only names defined there.
