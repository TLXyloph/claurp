# claurp — Handoff

_Last updated 2026-08-19. Placed in `docs/` (not repo root) per CLAURP CLAUDE.md's no-root-markdown rule. Uncommitted working file — not part of PR #1._

## Goal

Build **claurp**: an open-source, wake-word voice interface for CLI coding agents (Claude Code first). Say "hey claude, …" → a real agent session spawns, narrates aloud, asks risky permissions by voice, hands off to a terminal on request. Later: multimodal capture ("look at my screen" + cursor-ink deixis, "check this out" camera). **Bridge, not harness** — always spawn the user's real agent under their own login so flat subscriptions keep working.

- Public repo: **https://github.com/TLXyloph/claurp** (owner TLXyloph). Local dir still named `wakeWord`.
- Spec: `docs/superpowers/specs/2026-08-18-claurp-design.md`
- Project memory: `~/.claude/projects/.../memory/claurp-project.md` (has hard-won technical facts).
- Prior-art survey artifact: https://claude.ai/code/artifact/9aaf9dcc-2353-46e5-957c-fff9f818cc42

## Current Progress

### Plan 1 — v0.1 core (protocol + daemon): DONE, shipped as PR #1
- **PR #1: https://github.com/TLXyloph/claurp/pull/1** (branch `worktree-v01-core` → `main`, **not yet merged**). CI is **green**.
- Worktree lives at `.claude/worktrees/v01-core` (kept for PR-feedback iteration).
- Built, all reviewed task-by-task via superpowers subagent-driven-development: `@claurp/protocol` (WS message + binary-frame contract, the frozen spine) and `@claurp/daemon` (Silero VAD → sherpa-onnx wake → whisper.cpp STT → smart-turn v3; intent router; session manager; hardened permission deny-list; usage meter; rule-based narrator; Kokoro TTS in an isolated child process; WS server + CLI + demo + e2e). **256 tests.**
- Plan doc: `docs/superpowers/plans/2026-08-18-claurp-v01-core.md` (16 tasks).
- CI: `.github/workflows/ci.yml` — ubuntu, `pnpm install → build → lint → test` (build MUST precede lint/test so `@claurp/protocol` dist resolves). Model/brew-dependent audio tests self-skip; `CLAURP_SKIP_TTS=1` skips the real-Kokoro test.

### Plan 2 — Swift "senses" macOS app: MID-BRAINSTORM, design presented, AWAITING APPROVAL
The app is a pure WS client (audio + HUD) speaking the frozen protocol. **Three foundational decisions already made with the user:**
1. **Connect-only** — the app connects to a separately-run daemon (`ws://127.0.0.1:8765`); it does NOT spawn/supervise the daemon (that's Plan 3). Shows an "offline" state + backoff reconnect when the daemon is down.
2. **HUD scope = menu-bar icon + compact floating pill** (no session roster / history panel). Pill shows: live transcript while listening; session label + latest narration while working; a permission card with Allow/Deny when needs-you. Plus earcons + native notifications.
3. **Build = SwiftPM library (`ClaurpSensesCore`, unit-testable logic: protocol Codable mirror, PCM resampler, connection state machine, view-models) + a thin app target wrapped into an `.app` via XcodeGen `project.yml`.** Tests run `swift test` on a macOS CI runner.

**Design presented in chat (the six sections A–F), not yet approved:**
- A. Module layout (SwiftPM lib + XcodeGen app).
- B. Audio: mic → 16 kHz mono PCM16 → `BIN_MIC_PCM16_16K` streamed continuously (menu-bar "Pause listening" toggle; continuous is the privacy default, react if wrong). TTS: `BIN_TTS_PCM16_24K` → AVAudioEngine player @24 kHz; **barge-in on `speak.stop`/wake**.
- C. HUD: menu-bar state, floating `NSPanel` pill, 4 earcons, `UNUserNotificationCenter` with Allow/Deny actions, global PTT hotkey → `ptt` down/up.
- D. Connection: hello, respond to WS pings (daemon watchdog), backoff reconnect, offline state.
- E. **Testing — the key cross-language risk is the Swift client drifting from the frozen TS protocol.** Mitigation: a daemon-side script emits **golden fixtures** (canonical JSON for every message + sample binary frames), committed; Swift XCTest replays/round-trips them and fails on mismatch. Plus resampler + message→HUD-state unit tests. macOS CI job runs `swift test`; the existing Linux job keeps running the daemon.
- F. Scope: OUT = screen/ink/camera (v0.2/v0.3), daemon spawning/packaging/signing (Plan 3), expandable roster. **Honest gap:** `notify`'s `open-terminal` action has no senses→daemon wire path (protocol only has hello/ptt/permission.response), so Plan 2 renders only Allow/Deny actions; open-terminal deferred to a future protocol extension.

**Open user threads at pause:**
- User flagged **TTS naturalness as a priority.** Answer given: the voice engine is a DAEMON concern (Kokoro local = decent-not-premium). The lever for genuine naturalness is a **pluggable premium-voice adapter in the daemon — Cartesia Sonic (~90ms) or ElevenLabs Flash, BYO key** — a small daemon task worth scheduling. Plan 2's own naturalness responsibility = **gapless, low-latency PCM playback + instant barge-in** (must be an explicit, tested spec requirement — choppy playback ruins any voice).
- User has NOT yet approved the Plan 2 design. Next real step is to get that approval (or edits), THEN write the spec.

## What Worked
- **superpowers brainstorming → writing-plans → subagent-driven-development** end to end: fresh implementer + independent reviewer per task, adversarial (opus) security passes, a whole-branch final review. Caught real bugs per-task reviews couldn't (e.g. the WS server binding `0.0.0.0` with no auth).
- Frozen test files + frozen interfaces per task kept implementers honest; vendor-API "adapt-the-wrapper-only" notes handled real API drift.
- Verifying CI actually ran (not trusting a wrapper's exit code) caught the build-before-lint ordering bug.

## What Didn't Work (do NOT repeat)
- **smart-turn-v3.onnx takes Whisper log-mel `[1,80,800]`, NOT raw PCM** (output logit already sigmoid-applied). `mel.ts` is a from-scratch port of pipecat's `_whisper_features.py` (BSD-2, attributed).
- **smart-turn INVERTS on macOS `say` default voice** (flat prosody). Fixtures use `say -v Karen` + ≤200 ms tail-trim in `turn.ts`; Shelley is the fallback voice.
- **kokoro-js + onnxruntime-node CRASH in one process** → Kokoro TTS MUST run in a child process (IPC `serialization:"advanced"`). `HF_HOME` is a no-op for kokoro-js; set `@huggingface/transformers` `env.cacheDir` in the worker.
- whisper mis-transcribes the fixture's trailing "haiku" ~40% of runs → tests anchor on reliably-transcribed "file"/"notes" instead.
- CI: running `lint` before `build` fails because the daemon resolves `@claurp/protocol` from built dist.

## Next Steps
1. **Resume the Plan 2 brainstorm**: get the user's approval (or edits) on the six-section design above — especially the continuous-mic-with-pause privacy default, dropping `open-terminal` for now, and the golden-fixture cross-language sync approach.
2. On approval: write the spec to `docs/superpowers/specs/2026-08-19-claurp-senses-macos-design.md`, self-review, get user review, then invoke **superpowers:writing-plans**.
3. Standing recommendations to schedule (not blockers): a **premium-voice TTS adapter** in the daemon (naturalness); a **macOS CI job** for `swift test`; the **`open-terminal` protocol extension**; and Plan 3 concerns (`tsx` is currently a runtime dep — precompile the TTS worker for packaging; daemon spawning; signing).
4. Decisions already accepted by the user (don't relitigate): sherpa KWS model license = Apache-2.0; `bypassPermissions` mode kept for v0.1 despite disabling the hard-deny backstop (documented spec §5.4); PR (not local merge) for integration.

## How to resume
Start a fresh conversation and point it at this file (`docs/HANDOFF.md`) plus the spec and project memory. The Plan 2 brainstorm is a superpowers architectural-path task paused at the "design presented, awaiting approval" gate — do NOT write the spec or any Swift code until the user approves the design.
