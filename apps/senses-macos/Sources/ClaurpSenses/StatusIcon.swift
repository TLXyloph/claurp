import AppKit
import ClaurpSensesCore

enum StatusIcon {
    /// SF Symbol per HUD condition; template images track the menu-bar tint.
    /// `micDenied` takes precedence over all other states (spec §3.1): a
    /// denied mic means no audio is flowing regardless of connection state.
    static func image(for hud: HudState, micDenied: Bool = false) -> NSImage? {
        let name: String
        if micDenied {
            name = "mic.slash"
        } else if hud.offline {
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
