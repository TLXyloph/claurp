/// RMS level of Int16 PCM, normalized to 0.0...1.0 for HUD waveform rendering.
public enum PcmLevel {
    public static func rms(_ samples: [Int16]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sumSquares: Double = 0
        for sample in samples {
            let normalized = Double(sample) / 32768.0
            sumSquares += normalized * normalized
        }
        let meanSquare = sumSquares / Double(samples.count)
        return Float(meanSquare.squareRoot())
    }
}
