import SwiftUI
import AVFoundation

/// "Hear what claurp hears" diagnostic: a live mic level meter plus a
/// record/playback round-trip through the exact same 16 kHz Int16 chunk
/// pipeline the daemon consumes, so mic-routing issues (wrong device, dead
/// AEC aggregate channel, etc.) can be diagnosed by ear.
struct MicTesterView: View {
    @ObservedObject var levelStore: MicLevelStore
    @ObservedObject var recorder: MicTestRecorder
    let deviceInfo: () -> String

    @State private var deviceText = ""
    @State private var player: AVAudioPlayer?
    @State private var playbackStatus = ""

    private let refreshTimer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Microphone Tester")
                .font(.headline)

            VStack(alignment: .leading, spacing: 4) {
                Text("INPUT LEVEL")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                levelMeter
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("ACTIVE DEVICE")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(deviceText)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button(recorder.isRecording ? "Recording…" : "Record 3 s") {
                    recorder.startRecording()
                }
                .disabled(recorder.isRecording)

                Button("Play back") {
                    playRecording()
                }
                .disabled(recorder.isRecording || !FileManager.default.fileExists(atPath: MicTestRecorder.outputPath))
            }

            Text(statusText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 360, alignment: .leading)
        .onAppear { deviceText = deviceInfo() }
        .onReceive(refreshTimer) { _ in deviceText = deviceInfo() }
    }

    private var statusText: String {
        playbackStatus.isEmpty ? recorder.statusText : playbackStatus
    }

    /// Perceptual (sqrt) scaling so speech at moderate volume is clearly
    /// visible rather than reading as a sliver, matching the notch
    /// waveform's scaling.
    private var levelMeter: some View {
        GeometryReader { geo in
            let fraction = CGFloat(sqrt(Double(min(max(levelStore.level, 0), 1))))
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2))
                Capsule()
                    .fill(Color.accentColor)
                    .frame(width: geo.size.width * fraction)
            }
        }
        .frame(height: 10)
    }

    private func playRecording() {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: MicTestRecorder.outputPath))
            let newPlayer = try AVAudioPlayer(data: data)
            player = newPlayer
            newPlayer.play()
            playbackStatus = "Playing back…"
        } catch {
            playbackStatus = "Playback failed: \(error.localizedDescription)"
        }
    }
}
