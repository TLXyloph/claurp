# models/ asset provenance

This file records where the model assets referenced by `@claurp/daemon` come
from, and exactly how the committed `keywords-hey-claude.txt` keyword asset
was generated. Nothing under `~/.claurp/models/` is committed to this repo
(see `packages/daemon/tools/fetch-models.ts`); only this recipe and the
generated keyword-token file are.

## Downloaded models (Task 3)

All fetched by `packages/daemon/tools/fetch-models.ts` into `~/.claurp/models/`
(`$CLAURP_HOME/models` if `CLAURP_HOME` is set).

| id | url | sha256 | local file |
|---|---|---|---|
| silero-vad | `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx` | `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6` | `silero_vad.onnx` |
| kws-zipformer | `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2` | `f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a` | `kws-zipformer.tar.bz2` (tarball, extracted to `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/`) |
| smart-turn-v3 | `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.0.onnx` | `07a133aba31e2d0b523f17f8c2e4e65efe6d8f685efd12ca4fe21ebf4e798991` | `smart-turn-v3.onnx` |
| whisper-base-en | `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin` | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` | `ggml-base.en.bin` |

(sha256s copied from `task-3-report.md`, each independently re-verified there
via a second `shasum -a 256` pass; each is exactly 64 hex characters.)

The KWS tarball extracts to `sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01/`
containing `encoder|decoder|joiner-*.onnx` (+ int8-quantized variants),
`tokens.txt`, `bpe.model`, a sample `keywords.txt`/`keywords_raw.txt`, a
`test_wavs/` dir, and a `README.md`.

## Keyword asset generation (Task 4)

The KWS model matches BPE token sequences, so the wake phrase "hey claude"
must be encoded with the model's own `bpe.model` before it can be used as a
keyword-spotting target. This is dev-time-only tooling — the *output*
(`models/keywords-hey-claude.txt`) is committed and the daemon runtime never
invokes Python.

**Tool versions actually used:**

- `uv`/`uvx`: `0.11.17` (already installed at `~/.local/bin/uvx`, so the
  documented `uvx --from sherpa-onnx ...` path was used; no `pipx`/`pip
  install --user` fallback was needed).
- Python `sherpa-onnx` package (pulled transiently by `uvx`, not installed
  system-wide): `1.13.6` (confirmed via
  `python3 -c "import sherpa_onnx; print(sherpa_onnx.__version__)"` run
  inside the same `uvx` environment) — the same version number as the
  `sherpa-onnx-node` npm package pinned in `packages/daemon/package.json`
  (`^1.12.0`, resolved to `1.13.6`), since both are published from the same
  upstream `k2-fsa/sherpa-onnx` release.

**Command actually run (delta from the brief's sketch):** the brief's literal
`uvx --from sherpa-onnx sherpa-onnx-cli text2token ...` failed three times in
a row with `ModuleNotFoundError` for three transitive dependencies the
`sherpa-onnx` PyPI package does not declare but its CLI imports
unconditionally at module load: `click`, then `sentencepiece` (needed
because `--tokens-type bpe`), then `pypinyin` (imported by
`sherpa_onnx.cli`/`sherpa_onnx.utils` even though this run never uses pinyin
tokenization). Each was added via `uvx`'s `--with` flag rather than switching
away from `uvx` — `uvx`/`uv` themselves were present and working throughout,
so none of the brief's listed fallbacks (`pipx run`, `pip install --user`)
were needed. The subcommand name (`text2token`) and flag names (`--tokens`,
`--tokens-type`, `--bpe-model`) matched the brief exactly, confirmed first
via `uvx --from sherpa-onnx --with click sherpa-onnx-cli --help` and
`... text2token --help`.

Raw input (`HEY CLAUDE` with the `@HEY_CLAUDE` keyword-id annotation the CLI's
own `--help` documents — text before `@` is the phrase to tokenize, the
`@`-prefixed token is carried through verbatim into the output and is what
`KeywordSpotter.getResult(stream).keyword` reports on a hit):

```
HEY CLAUDE @HEY_CLAUDE
```

Exact command run (`$KWS_DIR` = `~/.claurp/models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`,
`$RAW` = a scratch path holding the one line above):

```bash
uvx --from sherpa-onnx --with click --with sentencepiece --with pypinyin \
  sherpa-onnx-cli text2token \
  --tokens "$KWS_DIR/tokens.txt" --tokens-type bpe --bpe-model "$KWS_DIR/bpe.model" \
  "$RAW" models/keywords-hey-claude.txt
```

Generated `models/keywords-hey-claude.txt` (committed, one line, verbatim):

```
▁HE Y ▁C LA U DE @HEY_CLAUDE
```

## Speech fixture voice (Task 6)

`packages/daemon/tools/make-fixtures.ts` synthesizes the speech fixtures
(`hey_claude.wav`, `hey_claude_status.wav`, `hey_claude_create_file.wav`,
`allow.wav`, `plain_speech.wav`) via macOS `say`. Originally this used
whatever voice was the system default (unspecified/unpinned); Task 6's
amended scope pinned it explicitly to **`say -v Karen`** (`en_AU`).

**Why:** the smart-turn-v3 end-of-turn model (`src/audio/turn.ts`) needs a
fixture where a complete utterance and a mid-word-cut utterance produce
clearly different completion probabilities. The system-default voice's flat,
TTS-typical prosody didn't separate them *at all* against the real model
(full=0.041, cut=0.517 — inverted), even with provably-correct mel-spectrogram
preprocessing (independently verified bit-identical against a Python
ground-truth run of the canonical reference). This is consistent with
smart-turn-v3.0's own release notes, which flag heavy reliance on synthetic
TTS training data as a known accuracy weakness.

**How Karen was chosen:** an empirical matrix (5 voice engines — the
system-default `say` voice, `say -v Daniel` (en_GB), `say -v Karen` (en_AU),
`say -v "Shelley (English (US))"`, and `kokoro-js` (`af_heart`, run via
`onnx-community/Kokoro-82M-v1.0-ONNX`, 24kHz resampled to 16kHz) — crossed
with 3 trailing-silence-trim settings applied inside `turn.ts`'s
preprocessing) against the real `smart-turn-v3.onnx` model. `say -v Karen`
combined with a <=200ms trailing-silence trim was the first configuration (in
the matrix's tested order) with comfortable, 3-run-stable separation:
full=0.6616, cut=0.0236. Full matrix table in `task-6-report.md`.

**kokoro-js note:** added as a `devDependency` of `@claurp/daemon`
(`kokoro-js`, Apache-2.0) purely for this voice experiment; it did not win
(both full and cut scored ~0.96-0.98 — no separation at all) so no fixture
uses it, but the dependency was kept since a later task may want it as a
runtime TTS engine. Its backend (`@huggingface/transformers`, also added as
a `devDependency`) caches the ~90MB `onnx-community/Kokoro-82M-v1.0-ONNX`
model under `~/.claurp/models/hf/` via `env.cacheDir` (set explicitly before
`from_pretrained()` — the package's own re-exported `env` does *not* carry a
`cacheDir` property, only `wasmPaths`; only the real
`@huggingface/transformers` `env` singleton does. `HF_HOME` has no effect at
all on this JS library — that's a Python-`transformers`-only convention).
Generating kokoro audio must run in a separate process from any code that
also loads `onnxruntime-node` directly (e.g. `turn.ts`'s own session) —
`@huggingface/transformers` bundles its own `onnxruntime-node` native addon,
and loading two instances in one process crashes with `std::bad_alloc`.

## Model licensing (spec open question #1)

Checked the KWS model's release page directly:
`https://github.com/k2-fsa/sherpa-onnx/releases/tag/kws-models`.

- `gh release view kws-models --repo k2-fsa/sherpa-onnx` shows an empty
  title and no license field.
- `gh api repos/k2-fsa/sherpa-onnx/releases/tags/kws-models --jq '.body'`
  returns an empty string — the release has no body text at all.
- A `WebFetch` render of the same release page independently confirmed: "The
  release page does not state any license for the models listed... No
  license text, badges, or statements appear anywhere on the page."

**Finding: license unstated on release page as of 2026-08-18.**

Aside, from a *different* source (not the release page, so not used to
override the finding above): the `README.md` bundled inside the downloaded
`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2` itself
carries a ModelScope-style frontmatter block stating `license: Apache
License 2.0` (mirrored from `https://www.modelscope.cn/pkufool/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`).
That's a real, verifiable statement from the model author's own repo, but
it is not the GitHub release page the task asked to check, and a
third-party mirror's frontmatter is weaker provenance than an explicit
license file/statement on the canonical release — so it is recorded here
as a data point only, not substituted as the answer to "what does the
*release page* say." Per the brief: if this ambiguity ever needs to be
resolved more strongly before v0.1 ships, file an issue to swap in
local-wake enrollment instead of depending on this asset's licensing.
