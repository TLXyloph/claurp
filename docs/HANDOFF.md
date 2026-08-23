# claurp — Handoff

_Last updated 2026-08-23 (~00:45 local), end of the Plan 2 + live-smoke session. Lives in `docs/` per the no-root-markdown rule; committed on branch `worktree-v02-senses`._

## Goal

**claurp**: open-source wake-word voice interface for CLI coding agents (Claude Code first). "hey claude, …" → real agent session, narrated aloud, permission-by-voice, terminal handoff. Bridge, not harness. Repo: https://github.com/TLXyloph/claurp (local dir `wakeWord`).

## Current Progress

- **Plan 1 (protocol + daemon): merged** (PR #1, commit 88ff4d7 on main). 249 daemon tests + protocol suite.
- **Plan 2 (Swift senses macOS app): COMPLETE — PR #2 open, CI green (both jobs): https://github.com/TLXyloph/claurp/pull/2**
  - Branch `worktree-v02-senses`, worktree at `.claude/worktrees/v02-senses` (kept for PR iteration).
  - Spec: `docs/superpowers/specs/2026-08-19-claurp-senses-macos-design.md` (amended during smoke). Plan: `docs/superpowers/plans/2026-08-19-claurp-senses-macos.md`.
  - Built via superpowers SDD: 17 tasks, per-task independent reviews, final whole-branch review + fix wave. 77 Swift tests + TS suites green.
  - Shipped: protocol Codable mirror locked by 30 golden fixtures (+ Linux CI drift gate), mic capture (pinned built-in device), TTS playback w/ pre-roll + barge-in, connection state machine, **notch drop-down HUD** (replaced the spec's original pill at user request) with **level-reactive waveform**, mic **switcher** (menu) + **tester** (record 3 s → play back what the daemon hears → `/tmp/claurp-mic-test.wav`), file diagnostics (`/tmp/claurp-senses.log`), earcons (wake-ack beep **muted by default** per user), notifications, ⌥Space PTT, macOS CI job (must run `macos-15`: Xcode 16 emits project objectVersion 77 that Xcode 15.4 can't open).
- **Live smoke: the full loop closed once** (wake → transcript → session → spoken answer) in a quiet room with continuous speech — but real-cadence usage exposed a **daemon remediation backlog** (below), which is the next plan.
- **voiceos-bridge**: separate idea seeded at `~/Desktop/personal-proj/voiceos-bridge/handoff.md` (voiceOS = WakoAI's Fn-activated notch assistant; its SDK is outbound-only MCP — "feed it video" likely must invert to a screen-capture tool voiceOS calls). Untouched otherwise.

## Daemon remediation backlog (NEXT PLAN — all live-evidenced 2026-08-23)

Priority order; #1–#2 are the product-makers:

1. **Wake→capture handoff drops leading audio.** Saying "hey claude what's my usage" in one breath transcribes only the last word(s); with a pause after wake it captures 0.4 s of silence. Capture must start from the wake word's end offset via a ring/lookback buffer (sherpa KWS reports keyword timing) instead of "whenever the pipeline transitions". **The e2e suite masks this**: it anchors assertions on late words in the fixture sentences (the documented whisper-flakiness workaround), so front-truncation passes.
2. **No speech-onset grace after wake.** Natural pause → VAD/turn instantly closes → constant 6656-sample (0.4 s) utterance → `[BLANK_AUDIO]`. After wake: wait up to ~5 s for voiced onset before arming turn-end; reject turns < ~0.5 s.
3. **Router spawns sessions from `[BLANK_AUDIO]`** (and junk) — narrates "starting blank audio", burns tokens. Filter and return to listening.
4. **Stuck-in-listening**: in some flows wake never re-arms; only a daemon restart recovers. Audit the pipeline state machine re-arm paths.
5. **Narrator verbosity + latency**: reads entire permission/notification text aloud; responses feel slow (Kokoro synth + whisper + spawn). Tighten narration tiers; consider the standing premium-TTS adapter here.
6. **No state replay on senses reconnect**: pending `hud.permission` isn't re-sent, stranding the HUD in needs-you with no card (daemon also stays blocked). Replay pending cards + session roster on hello.
7. Minor: whisper worker slow/degraded under load once; sherpa circular-buffer overflow warning under glitchy streams (self-heals).

New test assets needed: fixture WAVs with **wake + pause + command** and wake+command gaps at various cadences; assert on FIRST words of commands to kill the masking in #1.

## What Worked

- Full superpowers chain end-to-end: brainstorm (resumed via handoff) → spec → 17-task plan → SDD with fresh implementer + reviewer per task → final review + fix wave. Reviews caught real bugs pre-merge (post-stop chunk race, stale WS delegate callbacks, unenforced barge-in ordering test).
- Golden fixtures + Linux drift gate: cross-language contract locked without a Mac in CI's loop; Swift replay passed first try.
- Live debugging discipline that finally cracked the mic mystery: **content-reactivity tests beat RMS levels** (see below), file-based app diagnostics (`/tmp/claurp-senses.log`), a passive WS **observer** client printing every daemon message live, and a WS **injector** streaming fixture WAVs as real mic frames (both trivial node scripts against `ws`; recreate in ~40 lines — connect, hello, stream 320-sample 0x01 frames at 20 ms cadence).

## What Didn't Work (do NOT repeat)

- **`setVoiceProcessingEnabled(true)` (AEC) on macOS made the input a 9-channel aggregate of ALL input devices** (BlackHole/Teams/iPhone included); channel 0 landed on a silent virtual device → the daemon received noise. Even pinned it stayed unreliable. AEC is now OFF on the user's machine via `defaults write dev.claurp.senses claurpDisableAEC -bool true` — **TODO: flip the in-code default to AEC-off before/at PR #2 merge** (beep is muted, so AEC's original purpose is gone; revisit only for daemon-TTS self-hearing, ideally as senses-side half-duplex gating while TTS plays).
- **Validating audio by RMS alone** — twice "validated" a broken path because noise is loud. Always test *reactivity* (level responds to `say` playback) or *content* (record → transcribe/listen).
- Room noise matters: floor ~0.07–0.13 RMS drowned the wake/turn stack; quiet room (~0.002) worked. The daemon has no noise robustness yet (#2/#5 above).
- macos-14 CI runners (Xcode 15.4) can't open Xcode-16-generated projects (objectVersion 77) — `senses` job pins `macos-15`.
- A stray `intake_playground.py` had squatted port 8765 for 22 days — first "nothing happened" was just that. Check `lsof -iTCP:8765` before blaming code.
- Plan 1 lore that still holds: smart-turn needs `say -v Karen` fixtures; kokoro must live in a child process; tsx is a runtime dep (Plan 3).

## Environment / how to run

- Xcode 16.2 at /Applications (xcode-select set, license accepted); xcodegen 2.46 (brew). Models in `~/.claurp/models` (complete).
- Daemon: `node packages/daemon/dist/cli.js` (build first: `pnpm -r build`). App: `xcodegen generate && xcodebuild …` in `apps/senses-macos`, product in DerivedData (`ClaurpSenses-*/Build/Products/Debug/ClaurpSenses.app`).
- User-machine defaults currently set: `claurpDisableAEC=true`, `claurpInputDeviceUID` = built-in mic (via the in-app switcher).
- SDD ledger (rulings, deferred minors): `.claude/worktrees/v02-senses/.superpowers/sdd/2026-08-19-claurp-senses-macos/progress.md` (gitignored — dies with the worktree; key decisions are reflected in this file and the spec).

## Next Steps

1. **Merge PR #2** when ready (app side is done; two small pre-merge nits if desired: flip AEC default off in code; the reviewer-noted stale-buffer race on mic switch).
2. **Daemon remediation plan** (the backlog above) — fresh session: superpowers brainstorming → spec (or spec amendment to Plan 1's) → writing-plans → SDD. Start scoping from backlog #1/#2 + the new pause-fixtures.
3. Standing (unchanged): premium-voice TTS adapter (daemon), `open-terminal` protocol extension, Plan 3 (npx packaging, daemon spawn, signing; precompile TTS worker).
4. Optional thread: voiceos-bridge brainstorm from its own handoff.

## How to resume

Fresh conversation → point it at this file (`docs/HANDOFF.md`) + the project memory. For the daemon work, read Plan 1's spec §4 (voice pipeline) and `packages/daemon/src/audio/pipeline.ts` first, and treat the backlog above as the problem statement — do NOT start coding before the brainstorm/spec gate.
