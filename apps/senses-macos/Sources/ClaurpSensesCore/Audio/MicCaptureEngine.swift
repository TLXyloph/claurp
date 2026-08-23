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

    public init() {}

    public func start() throws {
        guard !isRunning else { return }
        let input = engine.inputNode
        // AEC subtracts our own device playback (earcons, TTS) from the
        // captured signal so the daemon never hears — and phantom-transcribes
        // — the app's own speaker output (spec §3.1).
        if (try? input.setVoiceProcessingEnabled(true)) == nil {
            NSLog("claurp: failed to enable voice processing (AEC); continuing un-cancelled")
        } else {
            // Voice processing ducks other audio (our TTS) by default; disable
            // that so our own playback isn't attenuated while AEC cancels it.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        // Query the format AFTER enabling voice processing — it can change
        // the input node's format (e.g. to 16 kHz mono for AEC processing).
        let format = input.inputFormat(forBus: 0)
        resampler = MicResampler(inputSampleRate: format.sampleRate)
        chunker.reset()
        // No input device (e.g. a headless Mac): inputFormat(forBus:) returns a
        // 0 Hz/0-channel format, which crashes installTap with an uncatchable
        // NSException. Bail out before it, leaving isRunning false.
        guard format.sampleRate > 0, format.channelCount > 0, resampler != nil else {
            NSLog("claurp: no usable audio input device; not starting capture")
            return
        }
        // Capture resampler into closure to avoid reading property from audio thread
        let resampler = self.resampler
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let channels = buffer.floatChannelData else { return }
            let mono = Array(UnsafeBufferPointer(start: channels[0],
                                                 count: Int(buffer.frameLength)))
            guard let resampled = resampler?.resample(mono), !resampled.isEmpty else { return }
            DispatchQueue.main.async {
                // Guard against post-stop execution of queued blocks
                guard self.isRunning else { return }
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
