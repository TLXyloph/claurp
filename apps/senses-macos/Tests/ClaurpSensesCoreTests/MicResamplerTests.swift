import XCTest
@testable import ClaurpSensesCore

final class MicResamplerTests: XCTestCase {
    private func sine(freq: Double, rate: Double, seconds: Double, amp: Float) -> [Float] {
        (0..<Int(rate * seconds)).map {
            amp * Float(sin(2.0 * .pi * freq * Double($0) / rate))
        }
    }

    func testDownsamples48kSineTo16k() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 48000))
        let input = sine(freq: 440, rate: 48000, seconds: 1.0, amp: 0.5)
        var out: [Int16] = []
        // Feed in 100 ms chunks like a live tap would.
        for start in stride(from: 0, to: input.count, by: 4800) {
            out += r.resample(Array(input[start..<min(start + 4800, input.count)]))
        }
        // Length: 1 s at 16 kHz, allowing converter priming latency.
        XCTAssertEqual(out.count, 16000, accuracy: 64)

        // Frequency via zero crossings.
        var crossings = 0
        for i in 1..<out.count where (out[i - 1] < 0) != (out[i] < 0) { crossings += 1 }
        let freq = Double(crossings) / 2.0 / (Double(out.count) / 16000.0)
        XCTAssertEqual(freq, 440, accuracy: 10)

        // RMS: 0.5 amplitude sine → 0.5/√2 × 32767 ≈ 11585.
        let rms = (out.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(out.count)).squareRoot()
        XCTAssertEqual(rms, 11585, accuracy: 1200)
    }

    // Added in fix round 1: 44.1 kHz is the other common macOS mic tap rate
    // (alongside 48 kHz), and unlike 48 kHz its ratio to 16 kHz (16000/44100
    // = 0.3628...) doesn't reduce to a clean fraction. This extends the
    // count/frequency/RMS safety net — which would catch a regression if the
    // vendor-drift workaround in MicResampler's slice-size scaling ever
    // stopped covering a real tap rate — beyond the single 48 kHz path the
    // brief's frozen tests exercise. Not a frozen assertion: tolerances here
    // were chosen to match the frozen 48 kHz test's tolerances, not copied
    // from the brief.
    func testDownsamples44100SineTo16k() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 44100))
        let input = sine(freq: 440, rate: 44100, seconds: 1.0, amp: 0.5)
        var out: [Int16] = []
        // Feed in 100 ms chunks like a live tap would (4410 samples at 44.1 kHz).
        for start in stride(from: 0, to: input.count, by: 4410) {
            out += r.resample(Array(input[start..<min(start + 4410, input.count)]))
        }
        // Length: 1 s at 16 kHz, allowing converter priming latency.
        XCTAssertEqual(out.count, 16000, accuracy: 64)

        // Frequency via zero crossings.
        var crossings = 0
        for i in 1..<out.count where (out[i - 1] < 0) != (out[i] < 0) { crossings += 1 }
        let freq = Double(crossings) / 2.0 / (Double(out.count) / 16000.0)
        XCTAssertEqual(freq, 440, accuracy: 10)

        // RMS: 0.5 amplitude sine → 0.5/√2 × 32767 ≈ 11585.
        let rms = (out.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(out.count)).squareRoot()
        XCTAssertEqual(rms, 11585, accuracy: 1200)
    }

    func testPassthroughAt16k() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 16000))
        let input = sine(freq: 200, rate: 16000, seconds: 0.5, amp: 0.25)
        var out: [Int16] = []
        for start in stride(from: 0, to: input.count, by: 1600) {
            out += r.resample(Array(input[start..<min(start + 1600, input.count)]))
        }
        XCTAssertEqual(out.count, 8000, accuracy: 64)
    }

    func testEmptyInputYieldsEmptyOutput() throws {
        let r = try XCTUnwrap(MicResampler(inputSampleRate: 48000))
        XCTAssertEqual(r.resample([]), [])
    }
}
