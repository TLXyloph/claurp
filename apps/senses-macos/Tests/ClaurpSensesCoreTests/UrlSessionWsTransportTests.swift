import XCTest
@testable import ClaurpSensesCore

/// Regression test for fix round 1: UrlSessionWsTransport's
/// URLSessionWebSocketDelegate callbacks must ignore a stale task (one that
/// is no longer `self.task`), the same way receiveLoop already does.
///
/// This is exercised directly and synchronously — no real socket handshake,
/// no expectations, no timeouts — so it cannot be flaky. `connect(url:)`
/// only *schedules* work on the main delegateQueue; because this test never
/// yields the run loop (no `wait(for:)`, no `await`, no sleep) between
/// `connect(url:)` and the assertions, no real OS-delivered delegate
/// callback can interleave with the synchronous calls below — only the
/// direct calls made here can produce events.
final class UrlSessionWsTransportTests: XCTestCase {
    func testStaleTaskDelegateCallbacksAreIgnored() {
        let transport = UrlSessionWsTransport()
        var events: [WsTransportEvent] = []
        transport.onEvent = { events.append($0) }

        // Establishes a real "current" task without ever yielding the run
        // loop, so no genuine async callback can race with the assertions.
        transport.connect(url: URL(string: "ws://127.0.0.1:1")!)

        // Stands in for a stale task reference (e.g. one close()/connect()
        // has already moved past): a task from an unrelated session is
        // guaranteed not to be `=== ` the transport's current task.
        let staleSession = URLSession(configuration: .ephemeral)
        let staleTask = staleSession.webSocketTask(with: URL(string: "ws://127.0.0.1:1")!)

        transport.urlSession(staleSession, webSocketTask: staleTask,
                             didOpenWithProtocol: nil)
        transport.urlSession(staleSession, webSocketTask: staleTask,
                             didCloseWith: .normalClosure, reason: nil)

        XCTAssertTrue(events.isEmpty,
                       "a stale task's delegate callbacks must not affect the current connection")

        transport.close()
        staleSession.invalidateAndCancel()
    }
}
