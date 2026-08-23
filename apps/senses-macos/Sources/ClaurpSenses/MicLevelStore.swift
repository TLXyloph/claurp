import Combine

/// Published mic input level (0.0...1.0 RMS) driving the HUD's reactive
/// waveform. Deliberately separate from HudStore/HudState: HudState's
/// equality-gating must keep firing only on real daemon state changes, not
/// on every mic chunk, so level flows through this store only.
final class MicLevelStore: ObservableObject {
    @Published var level: Float = 0
}
