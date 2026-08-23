public enum StateMode: String, Equatable {
    case idle, listening, working, disconnected
    case needsYou = "needs-you"
}

public enum EarconKind: String, Equatable {
    case shutter, done
    case wakeAck = "wake-ack"
    case permissionAsk = "permission-ask"
}

public enum SessionState: String, Equatable {
    case spawning, working, done, failed
    case needsPermission = "needs-permission"
    case needsInput = "needs-input"
    case handedOff = "handed-off"
}

/// `standard` maps to the wire value "default" (a Swift keyword).
public enum PermissionMode: String, Equatable {
    case standard = "default"
    case acceptEdits, plan, bypassPermissions
}

public enum NotifyAction: String, Equatable {
    case allow, deny
    case openTerminal = "open-terminal"
}

public enum PttAction: String, Equatable { case down, up }

public enum PermissionDecision: String, Equatable { case allow, deny, always }

public struct HudSession: Equatable {
    public let sessionId: String
    public let label: String
    public let state: SessionState
    public let permissionMode: PermissionMode
    public let narration: String?
    public init(sessionId: String, label: String, state: SessionState,
                permissionMode: PermissionMode, narration: String?) {
        self.sessionId = sessionId
        self.label = label
        self.state = state
        self.permissionMode = permissionMode
        self.narration = narration
    }
}

public struct HudPermission: Equatable {
    public let sessionId: String
    public let requestId: String
    public let tool: String
    public let detail: String
    public let spoken: String
    public init(sessionId: String, requestId: String, tool: String,
                detail: String, spoken: String) {
        self.sessionId = sessionId
        self.requestId = requestId
        self.tool = tool
        self.detail = detail
        self.spoken = spoken
    }
}

public struct NotifyPayload: Equatable {
    public let title: String
    public let body: String
    public let sessionId: String?
    public let requestId: String?
    public let actions: [NotifyAction]
    public init(title: String, body: String, sessionId: String?,
                requestId: String?, actions: [NotifyAction]) {
        self.title = title
        self.body = body
        self.sessionId = sessionId
        self.requestId = requestId
        self.actions = actions
    }
}

public enum DaemonMessage: Equatable {
    case helloAck(daemonVersion: String)
    case state(mode: StateMode)
    case transcriptPartial(text: String)
    case transcriptFinal(text: String)
    case earcon(kind: EarconKind)
    case hudSession(HudSession)
    case hudPermission(HudPermission)
    case notify(NotifyPayload)
    case speakStop
}

public enum SensesMessage: Equatable {
    case hello(client: String)
    case ptt(action: PttAction)
    case permissionResponse(sessionId: String, requestId: String, decision: PermissionDecision)
}
