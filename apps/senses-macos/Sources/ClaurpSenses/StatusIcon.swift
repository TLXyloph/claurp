import AppKit
import ClaurpSensesCore

enum StatusIcon {
    /// SF Symbol per HUD condition; template images track the menu-bar tint.
    static func image(for hud: HudState) -> NSImage? {
        let name: String
        if hud.offline {
            name = "bolt.slash"
        } else if hud.paused {
            name = "pause.circle"
        } else {
            switch hud.mode {
            case .idle, .disconnected: name = "waveform.circle"
            case .listening: name = "waveform"
            case .working: name = "hourglass"
            case .needsYou: name = "exclamationmark.bubble"
            }
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "claurp")
        image?.isTemplate = true
        return image
    }
}
