import AVFoundation
import ClaurpSensesCore

/// Preloads all four earcons so play() is low-latency.
final class EarconPlayer: EarconPlayerType {
    private var players: [EarconKind: AVAudioPlayer] = [:]

    init() {
        for kind in [EarconKind.wakeAck, .shutter, .permissionAsk, .done] {
            if let url = Bundle.main.url(forResource: kind.rawValue, withExtension: "wav"),
               let player = try? AVAudioPlayer(contentsOf: url) {
                player.prepareToPlay()
                players[kind] = player
            }
        }
    }

    func play(_ kind: EarconKind) {
        // The wake acknowledgment is now visual (notch opens + waveform) per
        // user request; the beep also risks acoustic feedback. Opt back in
        // with claurpWakeEarcon.
        if kind == .wakeAck, !UserDefaults.standard.bool(forKey: "claurpWakeEarcon") {
            return
        }
        guard let player = players[kind] else { return }
        player.currentTime = 0
        player.play()
    }
}
