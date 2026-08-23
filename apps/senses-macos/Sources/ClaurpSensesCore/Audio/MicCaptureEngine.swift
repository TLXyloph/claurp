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
