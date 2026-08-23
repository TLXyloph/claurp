// One-off earcon synthesizer. Run from apps/senses-macos:
//   swift scripts/gen-earcons.swift
// Writes 4 short WAVs to Resources/Earcons/. Committed output; re-run only
// if you intentionally change the sounds.
import Foundation

let rate = 24000

func tone(_ segments: [(freq: Double, seconds: Double)]) -> [Int16] {
    var out: [Int16] = []
    for seg in segments {
        let n = Int(Double(rate) * seg.seconds)
        let fade = min(n / 8, Int(0.005 * Double(rate))) // 5 ms fade in/out
        for i in 0..<n {
            var amp = 0.35
            if i < fade { amp *= Double(i) / Double(fade) }
            if i >= n - fade { amp *= Double(n - i) / Double(fade) }
            let sample = seg.freq == 0 ? 0.0
                : amp * sin(2.0 * .pi * seg.freq * Double(i) / Double(rate))
            out.append(Int16(sample * 32767.0))
        }
    }
    return out
}

func wavData(_ samples: [Int16]) -> Data {
    var d = Data()
    func le32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func le16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    let byteCount = UInt32(samples.count * 2)
    d.append(contentsOf: Array("RIFF".utf8)); le32(36 + byteCount)
    d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); le32(16)
    le16(1); le16(1); le32(UInt32(rate)); le32(UInt32(rate * 2)); le16(2); le16(16)
    d.append(contentsOf: Array("data".utf8)); le32(byteCount)
    for s in samples { le16(UInt16(bitPattern: s)) }
    return d
}

let earcons: [String: [(freq: Double, seconds: Double)]] = [
    "wake-ack": [(880, 0.07), (1320, 0.09)],
    "shutter": [(1200, 0.04), (500, 0.06)],
    "permission-ask": [(660, 0.09), (0, 0.03), (880, 0.12)],
    "done": [(1040, 0.07), (780, 0.12)],
]

let outDir = URL(fileURLWithPath: "Resources/Earcons", isDirectory: true)
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
for (name, segments) in earcons {
    let url = outDir.appendingPathComponent("\(name).wav")
    try wavData(tone(segments)).write(to: url)
    print("wrote \(url.path)")
}
