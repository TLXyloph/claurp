import Foundation

/// Captures the next 3 seconds of the exact 16 kHz mono Int16 chunks the
/// daemon receives (wired from `SensesController.onMicChunkTap`) and writes
/// them to a 16-bit PCM WAV file, so the mic tester can play back exactly
/// what the daemon hears — the diagnostic payoff of the whole feature.
final class MicTestRecorder: ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var statusText = "Idle"

    static let outputPath = "/tmp/claurp-mic-test.wav"
    private static let sampleRate = 16000
    private static let recordSeconds = 3.0

    private var buffer: [Int16] = []
    private var targetSampleCount = 0

    /// Wired from AppDelegate to `SensesController.onMicChunkTap`; called
    /// for every chunk the daemon receives. A no-op unless a recording is
    /// currently in progress.
    func receive(_ chunk: [Int16]) {
        guard isRecording else { return }
        buffer.append(contentsOf: chunk)
        if buffer.count >= targetSampleCount {
            finish()
        }
    }

    func startRecording() {
        guard !isRecording else { return }
        buffer.removeAll(keepingCapacity: true)
        targetSampleCount = Int(Double(Self.sampleRate) * Self.recordSeconds)
        isRecording = true
        statusText = "Recording 3 s…"
    }

    private func finish() {
        isRecording = false
        let samples = buffer
        buffer.removeAll()
        do {
            try Self.wavData(samples).write(to: URL(fileURLWithPath: Self.outputPath))
            statusText = "Recorded \(samples.count) samples to \(Self.outputPath)"
        } catch {
            statusText = "Write failed: \(error.localizedDescription)"
        }
    }

    /// 44-byte header + PCM16 mono data, same pattern as
    /// scripts/gen-earcons.swift's `wavData(_:)`, but 16 kHz mono (the
    /// daemon's wire format) rather than 24 kHz.
    private static func wavData(_ samples: [Int16]) -> Data {
        var d = Data()
        func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let byteCount = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); le32(36 + byteCount)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); le32(16)
        le16(1); le16(1); le32(UInt32(sampleRate)); le32(UInt32(sampleRate * 2)); le16(2); le16(16)
        d.append(contentsOf: Array("data".utf8)); le32(byteCount)
        for s in samples { le16(UInt16(bitPattern: s)) }
        return d
    }
}
