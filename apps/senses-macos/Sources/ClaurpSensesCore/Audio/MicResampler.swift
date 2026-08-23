import AVFoundation

/// Streaming Float32-mono → 16 kHz Int16-mono converter. One instance per
/// capture session; converter state carries across resample() calls, so
/// never signal end-of-stream (we stream forever).
public final class MicResampler {
    private let converter: AVAudioConverter
    private let inFormat: AVAudioFormat
    private let outFormat: AVAudioFormat
    private let ratio: Double
    private let maxSliceFrames: Int

    /// Longest *duration* of audio fed to the converter as a single atomic
    /// `convert(to:)` call, expressed in seconds rather than a fixed frame
    /// count — see `maxSliceFrames` below for why.
    private static let maxSliceDuration: Double = 0.02 // 20 ms

    /// Smallest allowed value for `maxSliceFrames`, so a pathologically low
    /// `inputSampleRate` can't shrink the slice to (or below) zero frames
    /// and spin the slicing loop in `resample(_:)` forever.
    private static let minSliceFrames = 64

    public init?(inputSampleRate: Double) {
        guard inputSampleRate > 0,
              let inF = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: inputSampleRate,
                                      channels: 1, interleaved: false),
              let outF = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                       sampleRate: 16000,
                                       channels: 1, interleaved: false),
              let conv = AVAudioConverter(from: inF, to: outF) else { return nil }
        inFormat = inF
        outFormat = outF
        converter = conv
        ratio = 16000.0 / inputSampleRate
        // Largest slice of `samples` fed to the converter as a single unit.
        //
        // Empirically, on this toolchain, `AVAudioConverter`'s input-block
        // API silently drops a small amount of output when the *same size*
        // input buffer (e.g. one 100 ms / 4800-frame chunk at 48 kHz) is
        // repeatedly converted as one atomic call across many `resample()`
        // invocations — measured at ~1.6% of total samples over a 1 s /
        // 10-chunk run, regardless of output-buffer capacity or
        // `primeMethod`. Internally re-slicing each incoming chunk into
        // pieces at or below this size before handing them to the
        // converter eliminates the loss (verified, at 48 kHz, down to
        // within a few samples of the theoretical output length across
        // slice sizes from 128 to 4700 frames — i.e. from ~2.7 ms up to
        // ~98 ms; only a full, repeated 100 ms/4800-frame atomic slice
        // reproduced the loss). This is a wrapper-only workaround; the
        // converter instance itself is still reused and its internal
        // filter state still carries across calls.
        //
        // The bound is derived from `inputSampleRate` (as a duration)
        // rather than hardcoded as an absolute frame count so it scales
        // sensibly across mic tap rates other than the 48 kHz this was
        // measured on: a fixed 960-frame bound would be 60 ms at 16 kHz
        // (needlessly coarse — most of a typical 100 ms live-tap chunk)
        // but only ~5 ms at 192 kHz (many more slices/allocations per
        // chunk than necessary). Twenty milliseconds sits comfortably
        // inside the empirically-verified safe range above, stays small
        // relative to a typical 100 ms tap chunk at any realistic mic
        // rate (44.1 kHz, 48 kHz, 96 kHz, ...), and `minSliceFrames`
        // floors it so absurdly low sample rates can't degenerate to a
        // zero-size (or infinite-looping) slice.
        maxSliceFrames = max(Self.minSliceFrames, Int((inputSampleRate * Self.maxSliceDuration).rounded()))
    }

    public func resample(_ samples: [Float]) -> [Int16] {
        guard !samples.isEmpty else { return [] }

        var result: [Int16] = []
        var offset = 0
        while offset < samples.count {
            let end = min(offset + maxSliceFrames, samples.count)
            result += convertSlice(Array(samples[offset..<end]))
            offset = end
        }
        return result
    }

    /// Converts one bounded slice of input samples, draining any output the
    /// converter has ready before returning.
    private func convertSlice(_ samples: [Float]) -> [Int16] {
        guard let inBuf = AVAudioPCMBuffer(pcmFormat: inFormat,
                                           frameCapacity: AVAudioFrameCount(samples.count)) else {
            return []
        }
        inBuf.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            inBuf.floatChannelData!.pointee.update(from: src.baseAddress!, count: samples.count)
        }

        let outCapacity = AVAudioFrameCount(Double(samples.count) * ratio) + 64
        var fed = false
        var result: [Int16] = []

        // AVAudioConverter's `convert(to:)` may report `.haveData` even after
        // filling the buffer we handed it, meaning more converted output is
        // already sitting in the converter's internal queue (e.g. carried
        // over from a previous slice's filter tail). One call per slice is
        // not enough to drain it — loop until the converter tells us it has
        // genuinely run out of input (`.inputRanDry`), only then waiting for
        // the next slice (or the next resample() call) to feed it more.
        drain: while true {
            guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity) else {
                break
            }
            var error: NSError?
            let status = converter.convert(to: outBuf, error: &error) { _, outStatus in
                if fed {
                    outStatus.pointee = .noDataNow // keep the stream open for the next call
                    return nil
                }
                fed = true
                outStatus.pointee = .haveData
                return inBuf
            }
            guard error == nil, status != .error else { break }

            if outBuf.frameLength > 0, let ch = outBuf.int16ChannelData {
                result += Array(UnsafeBufferPointer(start: ch.pointee, count: Int(outBuf.frameLength)))
            }

            switch status {
            case .haveData:
                continue drain // more output already buffered inside the converter; keep draining
            default:
                break drain // .inputRanDry (needs new input) or .endOfStream
            }
        }
        return result
    }
}
