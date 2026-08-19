# claurp — Design Specification

**Date:** 2026-08-18
**Status:** Draft for review
**License:** MIT
**Platform (v1):** macOS (Apple Silicon first), portable core

claurp is a wake-word voice interface for CLI coding agents. You say
"hey claude, refactor the auth flow" from anywhere on your Mac and an
agent session spawns, narrates its progress aloud, asks for risky
permissions by voice, and hands you a terminal with the full transcript
whenever you want to see it. Beyond dictation, it gives the agent eyes
on demand: "look at my screen" sends a capture annotated with the ink
trail your cursor deposited while you talked, and "check this out"
points your camera (including iPhone Continuity Camera) at the physical
world.

It is a bridge, not a harness: claurp always spawns the user's own
agent binary under the user's own login. It never calls model APIs and
never touches auth tokens.

---

## 1. Positioning

### 1.1 Whitespace (from the 2026-08-18 prior-art survey)

Three squares on the board are empty, and claurp's signature features
sit on all three:

1. **Wake word AND multimodal capture in one tool.** Every wake-word
   project is audio-only or not a CLI-agent tool; every screen-context
   tool is push-button or passive.
2. **Camera into a CLI coding agent.** qwen-audio-agent (Alibaba, the
   closest large project) ships wake word + five CLI agents but has
   image/video transport explicitly disabled.
3. **A persistent cursor-ink trail as model input.** Google's Magic
   Pointer and Apple's View Annotations validate point-and-talk deixis
   at platform scale; nobody deposits a decaying trail and feeds it to
   the model. Genuinely unbuilt.

Secondary open ground claurp also claims: voice approval of agent
permissions (Claude Code's `--permission-prompt-tool` / SDK callback,
almost universally unused), and publishing a permissively licensed
"hey claude" wake-word model (none exists since Porcupine's free tier
shut down 2026-06-30).

### 1.2 Closest prior art

Voice Mirror (10★ MIT, Windows-first alpha, ~70% overlap, dormant),
qwen-audio-agent (2.2k★ Apache-2.0, no vision), Hermes Agent (232k★,
wake word but zero multimodal, not a CLI-agent wrapper), Happy Coder
(23k★, voice permissions but metered SaaS voice, no capture),
superwhisper (commercial benchmark, no wake word, no vision). Roughly
twenty 0–10★ "hey claude" hobby repos died in eight months: demand is
real; a thin wrapper does not differentiate.

### 1.3 Headwinds, planned around honestly

- Anthropic closed wake-word requests as "not planned" and frames
  push-to-talk as deliberate. claurp's answer: the wake word lives
  outside the terminal, in an ambient layer Anthropic has said they
  will not build.
- The 2026 research direction is addressee detection ("was that aimed
  at me?") rather than wake phrases. claurp treats the wake word as
  one door in, not the only one (hotkey day one; addressee detection
  as a roadmap experiment).
- The always-recording ambient model (Recall, Cluely) is losing
  ground politically. claurp captures only on explicit voice command,
  with audible/visible shutter feedback.

### 1.4 Success metric

**Open-source traction is the primary metric** and wins conflicts:
30-second install, a demo GIF led by the ink feature, docs and a
contributor-friendly architecture from day one. Public launch happens
when the differentiator (ink) works, not before.

---

## 2. Product principles

1. **Spawn the real agent, never impersonate it.** LLM calls are made
   by the user's own CLI agent under its own auth. Flat subscriptions
   (Claude Pro/Max, ChatGPT, Google tiers) keep working; ToS-safe by
   construction.
2. **Local ears.** VAD, wake word, STT, turn detection, and default
   TTS run on device. Raw audio never leaves the machine. What leaves
   is what the user's agent was already going to receive.
3. **On-demand capture only.** No always-on screen recording, no
   ambient camera. Every captured frame has an audible shutter and a
   HUD flash.
4. **Meta-verbs are answered by the daemon, never by the agent.**
   Status, usage, and context-fill queries are served from passively
   collected stream metadata — zero prompt injection, zero context
   impact.
5. **Degrade honestly.** A backend without image support gets a spoken
   "this agent can't see images yet," never a silent drop. Bounded
   coverage is always announced.
6. **Sessions are the unit; surfaces are views.** The daemon owns
   headless sessions. HUD, notifications, and a terminal running
   `--resume` are views onto the same on-disk session.

---

## 3. Architecture

Two processes, one contract:

```
 senses (Swift menu-bar app; prebuilt binary shipped in the npm package)
 ├─ mic capture (16 kHz mono PCM)      ├─ HUD panel (SwiftUI floating window)
 ├─ screen capture (ScreenCaptureKit)  ├─ ink overlay (transparent, click-through)
 ├─ camera (AVFoundation)              ├─ native notifications (actionable)
 ├─ speaker playback + ducking         ├─ global hotkey (push-to-talk fallback)
 └─ Apple Foundation Models bridge     └─ menu-bar state (listening indicator)
              ▲▼  localhost WebSocket: JSON events + binary frames
 daemon (Node/TypeScript; installed via npx; runs headless)
 ├─ audio pipeline: Silero VAD → wake word → streaming STT → smart-turn
 ├─ intent router: verb grammar → capture / session / meta commands
 ├─ session manager + agent adapters (Claude Code first)
 ├─ narrator (3-tier ladder) + TTS orchestration (Kokoro default)
 ├─ meter service (passive usage/context rollups)
 └─ connector registry (screen, camera, ink are the built-in three)
```

- **`packages/protocol` is the spine:** typed definitions of every WS
  message and the adapter interface. The Swift↔TS contract is the
  portability seam — a Linux senses process later replaces the Swift
  helper without touching the daemon.
- All daemon-side ML runs via `onnxruntime-node` (plus whisper.cpp
  bindings). No Python anywhere in the product.
- Transport: JSON text frames for events; binary frames for PCM audio,
  images, and synthesized speech. Handshake carries protocol version;
  either side refuses mismatched majors with a spoken/visible error.
- Process supervision: the daemon relaunches a crashed helper; the
  helper shows a "disconnected" menu-bar state and retries when the
  daemon dies. A watchdog ping runs both ways. Failures are never
  silent (notification + one spoken line when possible).

---

## 4. Voice pipeline

- **VAD:** Silero VAD (MIT) gates everything; the wake model only runs
  on voiced audio.
- **Wake word, two tiers:**
  - *Default (v0.1):* sherpa-onnx open-vocabulary KWS — any phrase,
    including "hey claude," works with zero training (~3 MB model).
    Action item: verify the KWS model files' license before shipping
    (code is Apache-2.0; model license unstated).
  - *Flagship (v0.3):* train and publish an Apache-2.0 "hey claude"
    microWakeWord model (Apache code AND models; prebuilt
    `darwin_arm64` runtime exists). The model is a standalone
    community contribution with its training recipe in `models/`.
  - Wake phrase is user-configurable; multi-phrase→profile routing
    ("hey codex") is roadmap, not v1.
- **STT:** whisper.cpp (MIT, Metal) streaming; Moonshine ONNX as the
  low-latency alternative behind the same interface. Live partial
  transcript streams to the HUD as the user speaks.
- **End of utterance:** smart-turn v3 (BSD-2-Clause, ~12 ms CPU) — a
  semantic turn detector, not a silence timeout, because rambling
  multi-clause instructions are the norm when driving a coding agent.
- **Barge-in:** user speech or the wake word during TTS playback ducks
  and stops synthesis immediately (helper-side ducking; sub-100 ms
  target).
- **Push-to-talk fallback:** a global hotkey opens the same capture
  path, for the wake-word-averse and for noisy environments.
- **Routing (no LLM in the hot path):** a small verb grammar over the
  final transcript catches: capture verbs ("look at my screen,"
  "check this out"), session verbs ("new task," "status," "switch to
  …," "kill it," "show me the session"), permission verbs ("allow,"
  "deny," "allow always," "what exactly?"), mode verbs ("plan mode,"
  "auto-accept edits," "normal mode," "bypass permissions"), and meta
  verbs ("how full is this session," "usage this week"). Everything
  else is prompt text for the focused session. Fuzzy matches may
  consult the local narrator model (§7); never a cloud call.

---

## 5. Sessions and adapters

### 5.1 Session model

- Lifecycle: `spawning → working → needs-permission | needs-input →
  done | failed`, plus `handed-off` (terminal owns it).
- Auto-label: the narrator generates a 2–3 word label from the first
  prompt ("auth refactor"); labels are the spoken/HUD handle.
- **Focused-session routing:** follow-up utterances go to the session
  the user most recently addressed or that most recently spoke.
  "Switch to the auth one" / "new task" redirect. Concurrent sessions
  are supported from v0.1; the HUD roster lists them.
- **Working directory (deliberately boring v1 rule):** a config file
  of named projects plus a default workspace; "in *dotfiles*, …"
  routes by name. Frontmost-terminal cwd detection is explicitly
  deferred (wrong guesses write code into the wrong repo).
- Follow-ups to a working session use the adapter's queued-message /
  interrupt capability rather than spawning anew.
- The daemon never holds the only copy of anything: sessions are the
  backend's own on-disk sessions wherever the backend supports it.

### 5.2 Adapter contract (`packages/protocol`)

```ts
interface AgentAdapter {
  capabilities(): {
    images: boolean;
    permissions: "callback" | "flags" | "none";
    resume: boolean;
    queuedInput: boolean;
    permissionModes?: string[];       // e.g. Claude Code's four modes
  };
  spawn(opts: SpawnOpts): SessionHandle;   // cwd, prompt, model?, mode?
}
interface SessionHandle {
  send(content: Array<TextBlock | ImageBlock>): void;
  interrupt(): void;
  setPermissionMode?(mode: string): void;
  events(): AsyncIterable<AgentEvent>;
  // started | text-delta | tool-use | needs-permission | needs-input
  // | usage-metadata | done | error
  handoffCommand(): string | null;    // e.g. `claude --resume <id>`
  kill(): void;
}
```

A shared contract-test suite runs against every backend plus a fake
agent. Missing capabilities degrade honestly per principle 5.

### 5.3 Claude Code adapter (first-class)

- Built on the Agent SDK **streaming input mode** (AsyncGenerator of
  user messages) — the only mode accepting base64 image blocks, and
  the one supporting queued follow-ups and interruption.
- `settingSources` is set so the user's CLAUDE.md, MCP servers, and
  skills load exactly as in their terminal (the SDK skips them by
  default). This is the "your agent, your setup" promise.
- Sessions are real on-disk Claude Code sessions → handoff is
  `claude --resume <session-id>` in the user's terminal (or the
  desktop app). On handoff the daemon stops injecting and watches for
  completion; a voice command reclaims the session headless. Only one
  driver at a time.
- Feature detection reads the `system/init` capabilities array, never
  version sniffing.
- Permission modes (`default / acceptEdits / plan / bypassPermissions`)
  are settable mid-session by voice; `bypass` requires a spoken
  confirmation ("say 'confirm bypass'"). The HUD pill shows the active
  mode.
- Later backends, in order: Codex (App Server JSON-RPC — the richest
  third-party surface), Gemini CLI (headless JSONL), opencode/aider
  (AgentAPI or `--message` fallback), dsh (consumes its append-only
  session event log; serves API-key and local-model users).

### 5.4 Permission-by-voice

- Tool requests arrive via the SDK permission callback and are risk-
  classed by rules: `read / write / exec / network`.
- Default policy: reads auto-allow silently; writes and commands ask.
  Fully configurable per class and per project — **except a hard
  deny-list that never auto-allows under any policy:** recursive
  deletes, force-pushes, history rewrites, credential/secret file
  reads, and their equivalents.
- The ask: HUD card + notification showing the exact command, while
  the narrator speaks it ("Claude wants to run npm install — allow?").
  Verbs: allow / deny / **allow always** (persists to policy) /
  **"what exactly?"** (reads full detail). Notification buttons mirror
  the verbs. No response → the session waits; the notification
  persists; a reminder is spoken once after 60 s.
- **Known v0.1 limitation — `bypassPermissions` mode disables the
  backstop entirely.** The above ask flow (and the hard deny-list
  behind it) is enforced through the Claude Agent SDK's `canUseTool`
  permission callback. In `bypassPermissions` mode the SDK does not
  invoke `canUseTool` at all, so nothing arrives at the daemon for
  classification or deny-listing — a recursive delete or a force-push
  would run unmediated, exactly as it would if the user ran it
  directly in a terminal. The daemon has no architectural point to
  intercept this while a session is in bypass mode; it can only gate
  *entry* into the mode (spoken confirmation required — "confirm
  bypass" — with the narrator warning first). v0.1 keeps bypass mode
  rather than removing it, since it is a legitimate, pre-existing
  Claude Code capability and refusing to expose it would make claurp
  strictly less capable than typing the same command in a terminal.
  Revisit if/when the SDK exposes bypass-mode tool visibility.

### 5.5 Meter service (usage without touching context)

- Every adapter event stream carries token/cost metadata
  (`usage-metadata`); the daemon aggregates per session, day, and week
  across everything it spawned.
- Context fill is computed from the last turn's input-token count vs
  the model's window ("that session is about 40% full").
- Subscription weekly-limit specifics have no documented public API:
  v0.1 reports passive rollups plus any rate-limit events Claude Code
  emits, and the narrator says exactly what the number does and does
  not cover.

---

## 6. Multimodal capture

### 6.1 Screen + ink ("look at my screen")

- From wake-word fire, the helper buffers global cursor coordinates
  (cheap; points only, no pixels).
- When streaming STT detects a screen verb mid-utterance, the ink
  overlay appears: a transparent, click-through window rendering the
  cursor trail as a fading stroke, **backfilled** with the pre-verb
  path — the user sees what they have marked while still talking.
- At end-of-utterance: one ScreenCaptureKit frame of the display the
  cursor is on, trail burned in at full opacity with a time gradient
  (stroke order is legible to the model), sent as image blocks to the
  focused session.
- **Auto-crop:** if ink clusters in a region, send two images — the
  downscaled full screen and a full-resolution crop of the ink's
  bounding box. Circling a thing = a tight crop, for free.
- Privacy mechanics: audible shutter + HUD flash on every captured
  frame; claurp's own HUD is excluded from capture; terminal exclusion
  is a config option; frames persist only in the session transcript.
- If the focused backend lacks image support: honest spoken refusal.

### 6.2 Camera ("check this out")

- AVFoundation device enumeration — **iPhone Continuity Camera works
  day one** as an ordinary device.
- While aiming, the HUD shows a small live preview. A stability gate
  runs on preview frames: sharpness (variance of Laplacian) +
  inter-frame motion delta; auto-capture after ~400 ms of stillness,
  with shutter sound.
- If stability isn't reached within a few seconds the narrator coaches
  ("hold steady a moment"); "just take it" forces the shot; "and this
  one too" appends more frames. Same delivery path as screen frames.

---

## 7. Output surfaces

### 7.1 HUD + notifications

- SwiftUI floating panel, four states: hidden/idle; **listening**
  (live transcript); **working** (session label, latest narration
  line, permission-mode pill); **needs-you** (permission card with the
  exact command, Allow/Deny buttons). Expandable to a session roster
  and transcript pane. Menu-bar icon always shows master state
  (idle / listening / working / needs-you).
- Native notifications carry the same actions as the HUD, so a
  permission ask reaches the user in fullscreen apps with the HUD
  hidden — including when a session was handed off to a terminal.

### 7.2 Narrator (three-tier ladder)

1. **Rule-based templates** over the typed event stream — always
   present, free, local, cannot hallucinate ("editing auth.ts…",
   "tests passing, done").
2. **Lightweight local model** — default polish tier. On Apple
   Intelligence-capable Macs, the helper calls the on-device
   Foundation Models framework (no download, system-managed, guided
   generation fits "events → one spoken line"). Elsewhere, an optional
   ~1 GB Qwen-class GGUF via `node-llama-cpp` (Metal) in the daemon.
   Also used for session auto-labels and fuzzy-verb disambiguation.
3. **API polish** (Haiku-class) — opt-in for API-key holders.

- Speaking rules: narrate state changes, questions, and completion;
  stay silent through routine tool churn. Verbatim read-out whenever
  the agent asks an actual question. Verbosity dial:
  chatty / normal / quiet / silent.

### 7.3 TTS and sound

- Default: Kokoro (Apache-2.0 weights) via ONNX in the daemon,
  **sentence-streamed** so speech starts before the paragraph
  finishes; playback and ducking in the helper.
- Pluggable premium voices: ElevenLabs / Cartesia / OpenAI behind the
  same TTS interface.
- Distinct earcons: wake-ack, capture shutter, permission-ask, done.
  The ambient feel lives or dies on sound design.

---

## 8. Extensibility

- **Connector registry:** screen, camera, and ink ship as the first
  three connectors on the same internal API third parties will use.
  A connector declares: verbs it claims, capabilities it needs
  (helper-side capture, network, filesystem), and the content blocks
  it emits. Installs are transactional and fully reversible
  (Cordis-inspired revertible effects) — removing a connector removes
  every trace of it.
- **dsh relationship:** standalone core now; a dsh *adapter* when its
  preview API settles, and a published dsh voice *plugin* that thin-
  clients this daemon — one implementation visible in two ecosystems.
- Input validation at every boundary: WS messages schema-validated;
  file paths sanitized against traversal; connector manifests
  validated before load.

---

## 9. Testing

- **Adapter contract suite** shared across all backends + a scripted
  fake agent (mock-first / London-school; adapters and connectors are
  designed to interfaces for exactly this reason).
- **Audio goldens:** WAV fixtures → expected event streams (wake fired
  / not fired, transcript, turn boundary).
- **Protocol replay:** recorded WS sessions replayed against daemon
  and helper independently.
- **Ink compositing:** snapshot tests in the Swift package (trail
  render, burn-in, crop selection).
- CI on macOS runners for the Swift package; Linux runners cover the
  daemon (audio pipeline runs headless with fixture input).

---

## 10. Release ladder

- **v0.1 — working core (soft launch):** daemon + helper + protocol;
  sherpa-onnx wake; whisper.cpp streaming STT; smart-turn; Claude Code
  adapter with spawn/steer/interrupt, permission-by-voice, voice
  permission-mode switching; rule-based narrator; Kokoro TTS +
  barge-in; HUD pill + notifications; meta-verbs; named projects;
  terminal handoff.
- **v0.2 — public launch:** screen + ink (the demo GIF), session
  roster HUD, Codex adapter, Apple-FM narrator tier.
- **v0.3:** camera with stability gate; Gemini adapter; publish the
  Apache-2.0 "hey claude" microWakeWord model + training recipe;
  connector API stabilized and documented.
- **v0.4+:** dsh adapter + dsh voice plugin; attach-to-live-TUI
  injection (tmux/AppleScript); Linux senses process; addressee-
  detection experiment; self-improvement starts small — per-project
  outcome memory, learned verb corrections, connector suggestions.

---

## 11. Repo, install, license

- pnpm monorepo: `packages/protocol` (spine), `packages/daemon`,
  `apps/senses-macos` (Swift; ships prebuilt per-arch), `models/`
  (wake-model training recipe), `docs/`, `examples/`. Files under 500
  lines; typed public interfaces throughout.
- Install: `npx claurp` — first run downloads the helper binary and
  ~300 MB of models to `~/.claurp`, then walks mic / screen-recording
  / accessibility permissions with the narrator talking the user
  through it (the permissions walk *is* the first demo).
- **License: MIT.** Voice Mirror is cited as prior art. AGPL projects
  (Paseo, TalkiTo, claudecodeui) are read for ideas, never code.

---

## 12. Naming

- **claurp** (chosen 2026-08-18): npm free, PyPI free, GitHub clean
  (only substring hit: an unrelated `claurpg`). Wake phrase remains
  user-configurable and defaults to "hey claude"; the *product* name
  deliberately avoids Anthropic's "Claude" mark.
- Runner-up recorded: **handwave** — npm and PyPI free; GitHub crowded
  (120 name hits, none dominant: a dormant 2013 gesture library at
  200★, a 10★ LLM tool); crates.io check inconclusive (rate-limited).
  Available if a rename is ever wanted.

---

## 13. Non-goals (v1)

- Always-on screen/audio recording or ambient memory (screenpipe/
  Pieces territory).
- System-wide dictation into arbitrary apps (superwhisper/Wispr
  territory; Claude Code's `/voice` covers in-terminal dictation).
- Windows support; voice cloning; telephony/mobile clients;
  self-improvement loops beyond passive metrics.
- Building a harness. claurp drives harnesses; it is not one.

## 14. Open questions

1. sherpa-onnx KWS model file license — verify before v0.1 ships
   (fallback: local-wake's MIT DTW enrollment as interim default).
2. Claude Code Channels (research preview) — revisit as a connector
   transport once it exits allowlist gating.
3. Apple Foundation Models availability floor (macOS 26+) — confirm
   the graceful fallback path on macOS 15.
4. Voice-over-SSH / remote sessions (whitespace #4 in the survey) —
   deliberately unscheduled; revisit after v0.3.
5. Multi-display ink details (per-display overlay windows) — resolve
   during v0.2 implementation.
