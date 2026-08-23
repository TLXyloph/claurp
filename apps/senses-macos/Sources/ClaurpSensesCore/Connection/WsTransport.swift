import Foundation

public enum WsTransportEvent: Equatable {
    case opened
    case text(String)
    case data(Data)
    case closed(reason: String?)
}

public protocol WsTransport: AnyObject {
    var onEvent: ((WsTransportEvent) -> Void)? { get set }
    func connect(url: URL)
    func send(text: String)
    func send(data: Data)
    func close()
}
