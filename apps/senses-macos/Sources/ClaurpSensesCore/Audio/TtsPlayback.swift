public protocol PcmScheduler: AnyObject {
    func schedule(_ pcm: [Int16])
    func startPlayback()
    func stopAndFlush()
}

/// Gapless-playback gatekeeper (spec §3.2): schedule frames as they arrive,
/// start output only after ~100 ms of audio is queued (absorbs WS jitter),
/// and on barge-in stop + flush immediately, re-arming the pre-roll for the
/// next utterance. Known tradeoff (spec §3.2): pre-roll re-arms only after a
/// barge-in, not after a natural drain.
public final class TtsPlaybackController {
    private let scheduler: PcmScheduler
    private let prerollSamples: Int
    private var buffered = 0
    public private(set) var isPlaying = false

    public init(scheduler: PcmScheduler, prerollSamples: Int = 2400) {
        self.scheduler = scheduler
        self.prerollSamples = prerollSamples
    }

    public func receive(_ pcm: [Int16]) {
        guard !pcm.isEmpty else { return }
        scheduler.schedule(pcm)
        buffered += pcm.count
        if !isPlaying && buffered >= prerollSamples {
            scheduler.startPlayback()
            isPlaying = true
        }
    }

    public func bargeIn() {
        guard isPlaying || buffered > 0 else { return }
        scheduler.stopAndFlush()
        buffered = 0
        isPlaying = false
    }
}
