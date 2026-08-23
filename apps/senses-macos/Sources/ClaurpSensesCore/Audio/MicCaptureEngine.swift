import AVFoundation
import AudioUnit
import CoreAudio

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

    /// Fires at most every ~2s from the tap path with the raw (pre-resample)
    /// tap RMS (0...1), the number of raw tap frames, and the number of
    /// 320-sample chunks emitted since the last callback.
    public var onTapStats: ((_ tapRms: Float, _ tapFrames: Int, _ chunksEmitted: Int) -> Void)?
    /// Human-readable summary of the most recent start() outcome: pin
    /// outcome (device id or fallback reason), VP enabled/skipped/failed,
    /// and negotiated format (e.g. "48000 Hz 9ch").
    public private(set) var lastStartDescription = "not started"

    private var tapStatsSumSquares: Double = 0
    private var tapStatsFrames = 0
    private var tapStatsChunks = 0
    private var tapStatsLastEmit = Date.distantPast

    public init() {}

    public func start() throws {
        guard !isRunning else { return }
        let input = engine.inputNode
        // Pin capture to the built-in mic BEFORE enabling voice processing.
        // VPIO aggregates every input device (built-in mic, BlackHole, Teams,
        // etc.) into one multi-channel input, and which device lands on
        // channel 0 is not guaranteed to be the real mic — it can be a
        // silent virtual device, starving the daemon of real audio. Pinning
        // first keeps channel 0 on the real mic (spec §3.1).
        let deviceDescription: String
        if UserDefaults.standard.bool(forKey: "claurpUseDefaultInput") {
            NSLog("claurp: claurpUseDefaultInput set; using system default input device")
            deviceDescription = "default input (claurpUseDefaultInput set)"
        } else if let deviceID = AudioInputDevice.builtInInputID() {
            if let audioUnit = input.audioUnit {
                var deviceIDVar = deviceID
                let status = AudioUnitSetProperty(
                    audioUnit,
                    kAudioOutputUnitProperty_CurrentDevice,
                    kAudioUnitScope_Global,
                    0,
                    &deviceIDVar,
                    UInt32(MemoryLayout<AudioDeviceID>.size))
                if status == noErr {
                    NSLog("claurp: pinned capture input to built-in mic (device \(deviceID))")
                    deviceDescription = "device \(deviceID)"
                } else {
                    NSLog("claurp: failed to pin capture input to built-in mic (device \(deviceID)), status \(status); continuing with default input")
                    deviceDescription = "default input (pin failed, status \(status))"
                }
            } else {
                NSLog("claurp: input node has no audioUnit; cannot pin built-in mic, continuing with default input")
                deviceDescription = "default input (no audioUnit)"
            }
        } else {
            NSLog("claurp: no built-in input device found; continuing with default input")
            deviceDescription = "default input (no built-in device found)"
        }
        // AEC subtracts our own device playback (earcons, TTS) from the
        // captured signal so the daemon never hears — and phantom-transcribes
        // — the app's own speaker output (spec §3.1).
        let vpDescription: String
        if UserDefaults.standard.bool(forKey: "claurpDisableAEC") {
            NSLog("claurp: claurpDisableAEC set; skipping voice processing (AEC)")
            vpDescription = "VP skipped (claurpDisableAEC)"
        } else if (try? input.setVoiceProcessingEnabled(true)) == nil {
            NSLog("claurp: failed to enable voice processing (AEC); continuing un-cancelled")
            vpDescription = "VP failed"
        } else {
            // Voice processing ducks other audio (our TTS) by default; disable
            // that so our own playback isn't attenuated while AEC cancels it.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                .init(enableAdvancedDucking: false, duckingLevel: .min)
            vpDescription = "VP enabled"
        }
        // Query the format AFTER enabling voice processing — it can change
        // the input node's format (e.g. to 16 kHz mono for AEC processing).
        let format = input.inputFormat(forBus: 0)
        NSLog("claurp: negotiated input format sampleRate=\(format.sampleRate) channelCount=\(format.channelCount)")
        let formatDescription = "\(Int(format.sampleRate)) Hz \(format.channelCount)ch"
        lastStartDescription = "\(deviceDescription); \(vpDescription); \(formatDescription)"
        resampler = MicResampler(inputSampleRate: format.sampleRate)
        chunker.reset()
        tapStatsSumSquares = 0
        tapStatsFrames = 0
        tapStatsChunks = 0
        tapStatsLastEmit = Date()
        // No input device (e.g. a headless Mac): inputFormat(forBus:) returns a
        // 0 Hz/0-channel format, which crashes installTap with an uncatchable
        // NSException. Bail out before it, leaving isRunning false.
        guard format.sampleRate > 0, format.channelCount > 0, resampler != nil else {
            NSLog("claurp: no usable audio input device; not starting capture")
            lastStartDescription = "\(deviceDescription); \(vpDescription); no usable input format"
            return
        }
        // Capture resampler into closure to avoid reading property from audio thread
        let resampler = self.resampler
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let channels = buffer.floatChannelData else { return }
            let frameCount = Int(buffer.frameLength)
            let mono = Array(UnsafeBufferPointer(start: channels[0],
                                                 count: frameCount))
            var sumSquares: Double = 0
            for sample in mono { sumSquares += Double(sample) * Double(sample) }
            guard let resampled = resampler?.resample(mono), !resampled.isEmpty else { return }
            DispatchQueue.main.async {
                // Guard against post-stop execution of queued blocks
                guard self.isRunning else { return }
                let chunks = self.chunker.push(resampled)
                self.recordTapStats(sumSquares: sumSquares, frameCount: frameCount, chunksEmitted: chunks.count)
                for chunk in chunks {
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

    /// Accumulates tap-level counters (main thread only, alongside the
    /// existing chunk marshal) and forwards them via onTapStats at most
    /// every ~2s.
    private func recordTapStats(sumSquares: Double, frameCount: Int, chunksEmitted: Int) {
        tapStatsSumSquares += sumSquares
        tapStatsFrames += frameCount
        tapStatsChunks += chunksEmitted
        guard Date().timeIntervalSince(tapStatsLastEmit) >= 2.0 else { return }
        tapStatsLastEmit = Date()
        let meanSquare = tapStatsFrames > 0 ? tapStatsSumSquares / Double(tapStatsFrames) : 0
        onTapStats?(Float(meanSquare.squareRoot()), tapStatsFrames, tapStatsChunks)
        tapStatsSumSquares = 0
        tapStatsFrames = 0
        tapStatsChunks = 0
    }
}
