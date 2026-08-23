import SwiftUI

/// Reactive waveform: bar heights track a smoothed mic level, modulated
/// per-bar by a phase-offset sine of the timeline date so the bars undulate
/// organically instead of moving in lockstep. Smoothing has a fast attack /
/// slow decay so the waveform snaps up on speech and settles gently after.
struct WaveformView: View {
    @ObservedObject var levelStore: MicLevelStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var smoother = LevelSmoother()

    private let barCount = 6
    private let barWidth: CGFloat = 3
    private let barSpacing: CGFloat = 4
    private let minHeight: CGFloat = 4
    private let maxHeight: CGFloat = 18

    var body: some View {
        Group {
            if reduceMotion {
                staticBars
            } else {
                TimelineView(.animation) { timeline in
                    Canvas { context, size in
                        drawBars(context: context, size: size, date: timeline.date)
                    }
                }
            }
        }
        .frame(width: totalWidth, height: maxHeight)
    }

    private var totalWidth: CGFloat {
        CGFloat(barCount) * barWidth + CGFloat(barCount - 1) * barSpacing
    }

    private var staticBars: some View {
        HStack(spacing: barSpacing) {
            ForEach(0..<barCount, id: \.self) { _ in
                Capsule()
                    .fill(Color.white)
                    .frame(width: barWidth, height: (minHeight + maxHeight) / 2)
            }
        }
    }

    private func drawBars(context: GraphicsContext, size: CGSize, date: Date) {
        // Perceptual (sqrt) scaling with a small noise-floor cutoff: ambient
        // room noise (rms < ~0.01) reads as near-still, while speech —
        // which sqrt boosts much more than a linear map would — visibly
        // moves the bars.
        let rawLevel = levelStore.level
        let perceptualLevel = rawLevel < 0.01 ? 0 : sqrt(rawLevel)
        let smoothed = smoother.advance(toward: perceptualLevel)
        let t = date.timeIntervalSinceReferenceDate
        var x: CGFloat = (size.width - totalWidth) / 2
        for i in 0..<barCount {
            let phase = Double(i) * 1.3
            let wave = sin(t * 3.2 + phase)
            let idle: Float = 0.12
            let amplitude = max(smoothed, idle)
            let modulated = Float(Double(amplitude) * (1.0 + 0.3 * wave))
            let clamped = min(max(modulated, 0), 1)
            let height = minHeight + (maxHeight - minHeight) * CGFloat(clamped)
            let rect = CGRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
            let path = Path(roundedRect: rect, cornerRadius: barWidth / 2)
            context.fill(path, with: .color(.white))
            x += barWidth + barSpacing
        }
    }
}

/// Plain reference-type smoothing helper, held via @State so its identity —
/// and therefore its smoothed value — survives across the ~60 fps redraws
/// driven by the TimelineView, rather than resetting on every render.
final class LevelSmoother {
    private var value: Float = 0

    func advance(toward target: Float) -> Float {
        let rate: Float = target > value ? 0.5 : 0.08
        value += (target - value) * rate
        return value
    }
}
