import Foundation

public enum WireDecodeError: Error, Equatable {
    case malformed
}

public enum WireCodec {
    public static let protocolVersion = 1

    public static func encode(_ msg: SensesMessage) throws -> Data {
        var dict: [String: Any] = ["v": protocolVersion]
        switch msg {
        case .hello(let client):
            dict["type"] = "hello"
            dict["client"] = client
            dict["protocol"] = protocolVersion
        case .ptt(let action):
            dict["type"] = "ptt"
            dict["action"] = action.rawValue
        case .permissionResponse(let sessionId, let requestId, let decision):
            dict["type"] = "permission.response"
            dict["sessionId"] = sessionId
            dict["requestId"] = requestId
            dict["decision"] = decision.rawValue
        }
        return try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
    }

    /// nil = tolerated-unknown (unknown `type` or enum member): caller logs and drops.
    /// Throws `.malformed` for structurally invalid JSON: caller logs and drops.
    public static func decodeDaemon(_ data: Data) throws -> DaemonMessage? {
        let dec = JSONDecoder()
        struct Head: Decodable { let type: String }
        guard let head = try? dec.decode(Head.self, from: data) else {
            throw WireDecodeError.malformed
        }
        func payload<T: Decodable>(_ type: T.Type) throws -> T {
            guard let p = try? dec.decode(T.self, from: data) else {
                throw WireDecodeError.malformed
            }
            return p
        }

        switch head.type {
        case "hello.ack":
            struct P: Decodable { let daemonVersion: String }
            return .helloAck(daemonVersion: try payload(P.self).daemonVersion)
        case "state":
            struct P: Decodable { let mode: String }
            guard let mode = StateMode(rawValue: try payload(P.self).mode) else { return nil }
            return .state(mode: mode)
        case "transcript.partial":
            struct P: Decodable { let text: String }
            return .transcriptPartial(text: try payload(P.self).text)
        case "transcript.final":
            struct P: Decodable { let text: String }
            return .transcriptFinal(text: try payload(P.self).text)
        case "earcon":
            struct P: Decodable { let kind: String }
            guard let kind = EarconKind(rawValue: try payload(P.self).kind) else { return nil }
            return .earcon(kind: kind)
        case "hud.session":
            struct P: Decodable {
                let sessionId: String
                let label: String
                let state: String
                let permissionMode: String
                let narration: String?
            }
            let p = try payload(P.self)
            guard let state = SessionState(rawValue: p.state),
                  let mode = PermissionMode(rawValue: p.permissionMode) else { return nil }
            return .hudSession(HudSession(sessionId: p.sessionId, label: p.label,
                                          state: state, permissionMode: mode,
                                          narration: p.narration))
        case "hud.permission":
            struct P: Decodable { let sessionId, requestId, tool, detail, spoken: String }
            let p = try payload(P.self)
            return .hudPermission(HudPermission(sessionId: p.sessionId, requestId: p.requestId,
                                                tool: p.tool, detail: p.detail, spoken: p.spoken))
        case "notify":
            struct P: Decodable {
                let title: String
                let body: String
                let sessionId: String?
                let requestId: String?
                let actions: [String]?
            }
            let p = try payload(P.self)
            var actions: [NotifyAction] = []
            for raw in p.actions ?? [] {
                guard let action = NotifyAction(rawValue: raw) else { return nil }
                actions.append(action)
            }
            return .notify(NotifyPayload(title: p.title, body: p.body,
                                         sessionId: p.sessionId, requestId: p.requestId,
                                         actions: actions))
        case "speak.stop":
            return .speakStop
        default:
            return nil
        }
    }
}
