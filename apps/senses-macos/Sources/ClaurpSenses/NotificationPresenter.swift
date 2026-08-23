import UserNotifications
import ClaurpSensesCore

/// notify → UNUserNotificationCenter. Permission notifies (sessionId +
/// requestId + allow/deny actions) get actionable buttons; `open-terminal`
/// is not rendered (spec §2: no wire path back yet).
final class NotificationPresenter: NSObject, NotificationPresenterType,
                                   UNUserNotificationCenterDelegate {
    static let categoryId = "CLAURP_PERMISSION"
    var onDecision: ((_ sessionId: String, _ requestId: String, _ decision: PermissionDecision) -> Void)?

    func setUp() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(identifier: "ALLOW", title: "Allow")
        let deny = UNNotificationAction(identifier: "DENY", title: "Deny",
                                        options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.categoryId,
                                   actions: [allow, deny],
                                   intentIdentifiers: [])
        ])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func present(_ notify: NotifyPayload) {
        let content = UNMutableNotificationContent()
        content.title = notify.title
        content.body = notify.body
        if let sessionId = notify.sessionId, let requestId = notify.requestId,
           notify.actions.contains(.allow), notify.actions.contains(.deny) {
            content.categoryIdentifier = Self.categoryId
            content.userInfo = ["sessionId": sessionId, "requestId": requestId]
        }
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: UUID().uuidString,
                                  content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        let info = response.notification.request.content.userInfo
        guard let sessionId = info["sessionId"] as? String,
              let requestId = info["requestId"] as? String else { return }
        switch response.actionIdentifier {
        case "ALLOW": onDecision?(sessionId, requestId, .allow)
        case "DENY": onDecision?(sessionId, requestId, .deny)
        default: break
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
