import Foundation

/// URLSessionWebSocketTask-backed transport. The framework auto-replies to
/// server pings, satisfying the daemon's 5 s watchdog without client code.
/// All events are delivered on the main queue.
public final class UrlSessionWsTransport: NSObject, WsTransport, URLSessionWebSocketDelegate {
    public var onEvent: ((WsTransportEvent) -> Void)?
    private var task: URLSessionWebSocketTask?
    private var closedReported = false
    private lazy var session = URLSession(configuration: .ephemeral,
                                          delegate: self,
                                          delegateQueue: OperationQueue.main)

    public func connect(url: URL) {
        closedReported = false
        let task = session.webSocketTask(with: url)
        self.task = task
        receiveLoop(on: task)
        task.resume()
    }

    public func send(text: String) {
        task?.send(.string(text)) { _ in }
    }

    public func send(data: Data) {
        task?.send(.data(data)) { _ in }
    }

    public func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func receiveLoop(on task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self, let task, task === self.task else { return }
            switch result {
            case .success(.string(let text)):
                self.onEvent?(.text(text))
                self.receiveLoop(on: task)
            case .success(.data(let data)):
                self.onEvent?(.data(data))
                self.receiveLoop(on: task)
            case .success:
                self.receiveLoop(on: task)
            case .failure(let error):
                self.reportClosed(reason: error.localizedDescription)
            }
        }
    }

    private func reportClosed(reason: String?) {
        guard !closedReported else { return }
        closedReported = true
        task = nil
        onEvent?(.closed(reason: reason))
    }

    // MARK: URLSessionWebSocketDelegate
    //
    // Both callbacks below are async and reference the specific task they
    // originated from. If close() cancels task A and a subsequent connect()
    // assigns task B, task A's delegate callback can still arrive afterward
    // (URLSession does not guarantee cancellation cancels in-flight delegate
    // dispatch). Without filtering, a stale task A callback would act on the
    // CURRENT connection: reportClosed() would nil out self.task (orphaning
    // the live task B — its sends become silent no-ops and receiveLoop's own
    // task === self.task guard then permanently fails) and emit a spurious
    // .closed, which drives ConnectionManager into a needless retry or a
    // hung handshake. Guarding on identity here mirrors receiveLoop's guard
    // and ensures only the current task can mutate state / emit events.
    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        onEvent?(.opened)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                           didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                           reason: Data?) {
        guard webSocketTask === task else { return }
        reportClosed(reason: reason.flatMap { String(data: $0, encoding: .utf8) })
    }
}
