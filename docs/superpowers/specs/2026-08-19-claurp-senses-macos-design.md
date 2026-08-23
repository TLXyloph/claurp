# claurp senses (macOS) — Design Specification

**Date:** 2026-08-19
**Status:** Draft for review
**Scope:** Plan 2 — the Swift "senses" app for macOS
**Depends on:** `docs/superpowers/specs/2026-08-18-claurp-design.md` (v1 spec), `@claurp/protocol` v1 (frozen)

The senses app is claurp's face on macOS: a menu-bar app that streams
the microphone to the daemon, plays the daemon's voice out loud, and
shows a compact floating pill with what claurp is hearing and doing.
It is a **pure WebSocket client** of the frozen v1 protocol. It holds
no sessions, runs no models, and makes no decisions — the daemon is
the brain; senses is ears, mouth, and a small face.

Three foundational decisions (settled during brainstorm, 2026-08-19):

1. **Connect-only.** The app connects to a separately-run daemon at
   `ws://127.0.0.1:8765`. It does not spawn, supervise, or install the
   daemon — that is Plan 3. When the daemon is down, senses shows an
   offline state and reconnects with backoff.
2. **HUD scope = menu-bar icon + one compact floating pill.** No
   session roster, no history panel. The pill shows the live
   transcript while listening, the session label plus latest narration
   while working, and a permission card with Allow/Deny when the agent
   needs the user. Earcons and native notifications round it out.
3. **Build = SwiftPM library + thin app target.** All logic lives in a
   unit-testable SwiftPM library (`ClaurpSensesCore`); a thin app
   target is wrapped into a `.app` by XcodeGen. Tests run with
   `swift test` on a macOS CI runner.

---

## 1. Module layout

New top-level directory `apps/senses-macos/` (the pnpm workspace under
`packages/` stays TypeScript-only):

```
apps/senses-macos/
  Package.swift                 # ClaurpSensesCore library + tests
  project.yml                   # XcodeGen: ClaurpSenses.app target
  Sources/
    ClaurpSensesCore/
      Protocol/                 # Codable mirror of @claurp/protocol v1
      Audio/                    # capture, resampler, playback
      Connection/               # WS client, state machine, backoff
      Hud/                      # view-models (pure reducers)
    ClaurpSenses/               # thin app target: AppDelegate, wiring,
                                # NSStatusItem, NSPanel, SwiftUI views
  Tests/
    ClaurpSensesCoreTests/
      Fixtures/                 # committed golden fixtures (see §6)
```

`ClaurpSensesCore` contains everything with logic worth testing:
protocol types and codecs, the PCM resampler, the connection state
machine, and the HUD view-models. The `ClaurpSenses` app target is
deliberately thin — AppKit/SwiftUI shell, audio device wiring, and
dependency injection only.

App target facts: macOS 14+, Apple Silicon first; `LSUIElement = true`
(menu-bar only, no Dock icon); `NSMicrophoneUsageDescription` in
Info.plist; unsandboxed and unsigned for v0.1 (signing, notarization,
and packaging are Plan 3).

## 2. Protocol mirror (Swift ↔ frozen TS contract)

`ClaurpSensesCore/Protocol` mirrors `packages/protocol/src/messages.ts`
exactly, protocol version 1:

- **senses → daemon:** `hello { client, protocol }`,
  `ptt { action: down|up }`,
  `permission.response { sessionId, requestId, decision: allow|deny|always }`.
- **daemon → senses:** `hello.ack { daemonVersion }`,
  `state { mode: idle|listening|working|needs-you|disconnected }`,
  `transcript.partial { text }`, `transcript.final { text }`,
  `earcon { kind: wake-ack|shutter|permission-ask|done }`,
  `hud.session { sessionId, label, state, permissionMode, narration? }`,
  `hud.permission { sessionId, requestId, tool, detail, spoken }`,
  `notify { title, body, sessionId?, requestId?, actions[] }`,
  `speak.stop`.
- **Binary frames:** `[1 byte type][little-endian PCM16 payload]` —
  `0x01` mic PCM16 @ 16 kHz (senses → daemon), `0x02` TTS PCM16 @
  24 kHz (daemon → senses).

Decoding policy (forward compatibility): an unknown `type` value or an
unknown enum member in a *daemon → senses* message is logged and
dropped — never a crash. Known messages with extra unknown fields
decode fine (ignore unknown keys). Malformed binary frames (empty, or
odd payload length) are dropped with a log, matching the daemon's own
behavior.

`notify.actions` may contain `open-terminal`, but the frozen protocol
has no senses→daemon message to act on it. Senses renders only the
`allow`/`deny` actions and silently ignores `open-terminal` (documented
gap; see §8).

## 3. Audio

### 3.1 Capture (mic → daemon)

- AVAudioEngine input tap at the hardware format → `AVAudioConverter`
  → 16 kHz mono Int16 → `0x01` binary frames, sent in ~20 ms chunks
  (320 samples / 640 bytes) to keep wake-word latency low.
- The mic input is voice-processed (AEC) so the daemon never hears the
  app's own earcons or TTS played back through the speakers.
- Input is pinned to the built-in microphone before voice processing is
  enabled (voice-processing aggregates make the default-device channel
  layout unreliable); `claurpUseDefaultInput`/`claurpDisableAEC`
  UserDefaults escape hatches exist.
- **Streaming is continuous by default** — the daemon owns wake-word
  detection, so "hey claude" only works if audio is always flowing.
  Privacy posture: audio goes to a loopback-bound local daemon and
  never leaves the machine.
- **Pause listening** menu-bar toggle stops the tap entirely (macOS
  mic-in-use indicator goes off — the honest signal). While paused,
  no `0x01` frames are sent. State is not persisted across launches;
  the app always starts listening (and says so via the menu-bar icon).
- Mic permission: request on first launch; if denied, the menu-bar
  icon shows an error state with a menu item deep-linking to System
  Settings → Privacy → Microphone.

### 3.2 Playback (daemon TTS → speakers)

- `0x02` frames → AVAudioEngine + `AVAudioPlayerNode` at 24 kHz mono.
  Buffers are scheduled as they arrive after a small pre-roll
  (~100 ms) to absorb jitter without adding noticeable latency.
- **Gapless playback and instant barge-in are spec requirements, not
  nice-to-haves** — choppy playback ruins any voice, local or premium.
  Concretely: no audible gap between consecutive frames of one
  utterance, and on `speak.stop` the player stops and flushes all
  queued buffers within 50 ms. Defensively, `earcon { kind: wake-ack }`
  also triggers the same stop-and-flush — the user just said the wake
  word; nothing should be talking over them even if a `speak.stop` got
  lost.
- Output goes to the system default device; no device picker in v0.1.

### 3.3 PTT hotkey

Global hold-to-talk hotkey (default **⌥Space**) registered via Carbon
`RegisterEventHotKey` — works app-inactive and needs no Accessibility
or Input Monitoring permission. Key down sends `ptt { action: down }`,
key up sends `ptt { action: up }`. No rebinding UI in v0.1 (a
UserDefaults override is fine).

## 4. HUD

### 4.1 Menu bar

`NSStatusItem` whose icon reflects the daemon's `state.mode` plus two
local states: `idle`, `listening`, `working`, `needs-you`,
`disconnected` (offline), and `paused`. Menu: Pause/Resume Listening,
Reconnect Now (only while offline), Quit.

### 4.2 Notch drop-down

One compact, non-activating `NSPanel` (`.statusBar` level, joins all
Spaces, stationary, ignores mouse except its own controls), SwiftUI
content. Fixed top-center position, flush with the screen's top edge —
visually extending the MacBook notch — and non-draggable; it animates
open (slides down) and closed (retracts) rather than simply appearing.

| Daemon state | Panel shows |
|---|---|
| `idle` | hidden |
| `listening` | a level-reactive waveform (driven by live mic input) + live transcript (`transcript.partial` overwritten in place; `transcript.final` replaces it and holds until the next state change) |
| `working` | session label + latest `hud.session.narration` |
| `needs-you` | permission card: `tool`, `detail`, **Allow / Deny** buttons → `permission.response` (allow/deny; "always" is voice-only in v0.1) |
| `disconnected` | small "claurp offline" chip (auto-hides after a few seconds; menu-bar icon carries the persistent signal) |

The panel is driven by a pure reducer: `HudViewModel` folds
daemon messages into a `HudState` value — fully unit-testable with no
AppKit imports.

### 4.3 Earcons and notifications

- Four bundled sounds mapped 1:1 to `earcon.kind` (`wake-ack`,
  `shutter`, `permission-ask`, `done`), played via `AVAudioPlayer` for
  low latency.
- `notify` → `UNUserNotificationCenter`. When the message carries
  `sessionId` + `requestId` and `allow`/`deny` actions, the
  notification uses a category with Allow and Deny action buttons that
  send `permission.response`. `open-terminal` is not rendered (§2).

## 5. Connection

State machine in `ClaurpSensesCore/Connection`, transport-abstracted
so it unit-tests against a mock:

```
disconnected → connecting → helloSent → connected
      ↑                                    |
      └—— backoff (0.5 s doubling to 10 s cap, ±20% jitter) ——┘
```

- On socket open, send `hello { client: "senses-macos", protocol: 1 }`
  as the **first** message — the daemon closes with code 4000
  otherwise. `hello.ack` completes the handshake; mic streaming and
  message handling start only after it.
- The daemon's watchdog pings every 5 s and terminates after 3 missed
  pongs. Transport is `URLSessionWebSocketTask`, which auto-replies to
  pings at the framework level — no code needed. The loopback
  integration test (§6.3) proves this auto-pong mechanism by having
  its stub server ping the client repeatedly and then asserting the
  connection survives and still delivers traffic afterward (~1.2 s);
  a longer soak adds no further proof, since the stub has no
  terminate-on-missed-pong watchdog of its own to survive against.
- Any disconnect (including 4000 or daemon exit) → `disconnected`,
  offline HUD state, backoff reconnect loop. Reconnect resets backoff
  after a successful handshake.

## 6. Testing

The key cross-language risk: the Swift protocol mirror silently
drifting from the frozen TS contract. Golden fixtures are the
mitigation.

### 6.1 Golden fixtures (contract sync)

- A generator script `packages/protocol/scripts/emit-golden-fixtures.ts`
  uses the real zod schemas + `encodeBinaryFrame` to emit canonical
  fixtures into
  `apps/senses-macos/Tests/ClaurpSensesCoreTests/Fixtures/`:
  at least one JSON instance per message type in both directions,
  covering every enum variant (state modes, earcon kinds, session
  states, permission modes, decisions, notify action combos), plus
  sample `0x01`/`0x02` binary frames with known PCM patterns.
- Fixtures are **committed**. The existing Linux CI job regenerates
  them and fails on `git diff --exit-code` — so a TS protocol change
  that isn't reflected in committed fixtures breaks CI even with no
  Mac in the loop.
- Swift XCTest replays every fixture. Daemon→senses messages are
  decode-only by design (no `DaemonMessage` encoder exists in the
  Swift client): each fixture is decoded and asserted equal to the
  expected value. Senses→daemon messages are encoded from the Swift
  model and structurally compared against the fixture (JSON key order
  may differ). Binary fixtures round-trip through the Swift frame
  codec byte-for-byte.

### 6.2 Unit tests (`swift test`)

- Resampler: 48 kHz float sine → 16 kHz Int16; assert frequency and
  RMS within tolerance, output length exact.
- Frame codec: encode/decode round-trip, malformed-frame rejection
  (empty, odd length) matching daemon behavior.
- Connection state machine against a mock transport: hello-first
  ordering, handshake gate, backoff schedule (with jitter clamped for
  determinism), reset-after-reconnect.
- `HudViewModel` reducer: message sequences → expected `HudState`
  (transcript overwrite, narration updates, permission card
  show/clear, offline transitions).

### 6.3 Integration and CI

- One loopback integration test: an in-process WebSocket server
  (Network.framework `NWListener`) that pings repeatedly; assert
  handshake, a mic-frame send, a TTS-frame receive, and that the
  connection survives the pings and still delivers a message
  afterward (~1.2 s) — proving the auto-pong mechanism, not a fixed
  soak duration (see §5). Self-skips if the sandbox forbids listening
  sockets.
- CI: a new **macos-latest** job runs `swift test` (and `xcodegen
  generate` + `xcodebuild build` as a smoke check that the app target
  wires up). The existing ubuntu job keeps building/testing the daemon
  and now also runs the fixture drift check (§6.1).

## 7. Naturalness ownership (recorded decision)

Voice naturalness splits cleanly: the **engine** (Kokoro today; a
pluggable premium-voice adapter — Cartesia Sonic or ElevenLabs Flash,
BYO key — worth scheduling) is a **daemon** concern and out of scope
here. Senses owns the part it can ruin: gapless low-latency playback
and instant barge-in, specified and tested in §3.2. A premium voice
played choppily sounds worse than Kokoro played well.

## 8. Non-goals (Plan 2)

- Screen/ink capture and camera (v0.2/v0.3 — the protocol will grow
  `BIN_`/message types for them later; §2's unknown-message policy
  means an older senses build degrades gracefully).
- Spawning, supervising, installing, packaging, signing, or updating
  the daemon (Plan 3).
- Session roster / history panel; multi-session UI beyond the single
  focused pill.
- `notify`'s `open-terminal` action — requires a senses→daemon
  protocol extension; deferred and tracked as a standing
  recommendation.
- TTS engine choice / premium voices (daemon; §7).
- Settings UI (hotkey rebinding, device pickers, launch-at-login).
- Windows/Linux senses clients.

## 9. Open questions

None blocking. Two defaults chosen here that user testing may revise:
the ⌥Space PTT default (conflicts with some app shortcuts) and the
pill's auto-hide timing on `disconnected`.
