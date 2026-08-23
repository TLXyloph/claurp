public enum HudEvent: Equatable {
    case daemon(DaemonMessage)
    case connection(ConnectionState)
    case pause(Bool)
    case permissionResolved
}

public enum HudReducer {
    public static func reduce(_ state: HudState, _ event: HudEvent) -> HudState {
        var s = state
        switch event {
        case .connection(let conn):
            if case .connected = conn {
                s.offline = false
            } else {
                s.offline = true
                s.mode = .disconnected
                s.permission = nil
            }

        case .pause(let paused):
            s.paused = paused

        case .permissionResolved:
            s.permission = nil

        case .daemon(let msg):
            switch msg {
            case .state(let mode):
                if mode != s.mode {
                    s.transcript = ""
                    s.transcriptIsFinal = false
                }
                s.mode = mode
                if mode != .needsYou {
                    s.permission = nil
                }
            case .transcriptPartial(let text):
                s.transcript = text
                s.transcriptIsFinal = false
            case .transcriptFinal(let text):
                s.transcript = text
                s.transcriptIsFinal = true
            case .hudSession(let session):
                if session.sessionId != s.sessionId {
                    s.narration = ""
                }
                s.sessionId = session.sessionId
                s.sessionLabel = session.label
                if let narration = session.narration {
                    s.narration = narration
                }
            case .hudPermission(let card):
                s.permission = card
            case .helloAck, .earcon, .notify, .speakStop:
                break // handled elsewhere (controller / earcons / notifications)
            }
        }
        return s
    }
}
