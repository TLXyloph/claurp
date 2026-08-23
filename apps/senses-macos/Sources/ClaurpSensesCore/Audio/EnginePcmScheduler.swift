import AVFoundation

/// AVAudioPlayerNode-backed output at 24 kHz mono. player.stop() flushes all
/// scheduled buffers synchronously — that is the ≤50 ms barge-in guarantee.
public final class EnginePcmScheduler: PcmScheduler {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                       sampleRate: 24000, channels: 1,
                                       interleaved: false)!

    public init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
    }

    public func schedule(_ pcm: [Int16]) {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                            frameCapacity: AVAudioFrameCount(pcm.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(pcm.count)
        let dst = buffer.floatChannelData!.pointee
        for i in 0..<pcm.count {
            dst[i] = Float(pcm[i]) / 32768.0
        }
        player.scheduleBuffer(buffer)
    }

    public func startPlayback() {
        if !engine.isRunning {
            try? engine.start()
        }
        player.play()
    }

    public func stopAndFlush() {
        player.stop()
    }
}
