public struct HudState: Equatable {
    public var mode: StateMode = .disconnected
    public var paused = false
    public var offline = true
    public var transcript = ""
    public var transcriptIsFinal = false
    public var sessionId = ""
    public var sessionLabel = ""
    public var narration = ""
    public var permission: HudPermission? = nil

    public init() {}

    public enum Pill: Equatable {
        case hidden
        case listening(transcript: String)
        case working(label: String, narration: String)
        case permission(HudPermission)
        case offline
    }

    /// Derived pill content (spec §4.2 table).
    public var pill: Pill {
        if offline { return .offline }
        switch mode {
        case .idle, .disconnected:
            return .hidden
        case .listening:
            return .listening(transcript: transcript)
        case .working:
            return .working(label: sessionLabel, narration: narration)
        case .needsYou:
            if let permission { return .permission(permission) }
            return .working(label: sessionLabel, narration: narration)
        }
    }
}
