import UserNotifications
import UIKit

enum NotificationManager {
    /// Request permission to show notifications
    static func requestPermission() async {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            print("Notification permission granted: \(granted)")
        } catch {
            print("Notification permission error: \(error)")
        }
    }

    /// Show a notification for an incoming message (only fires when app is backgrounded)
    static func showMessageNotification(_ message: Message) {
        let enabled = UserDefaults.standard.object(forKey: "notificationsEnabled") as? Bool ?? true
        guard enabled, message.role == .assistant else { return }

        // Only notify when app is not active
        guard UIApplication.shared.applicationState != .active else { return }

        let content = UNMutableNotificationContent()

        // Different titles based on message type
        switch message.type {
        case .question:
            content.title = "AI Assistant is asking..."
        case .multipleChoice:
            content.title = "AI Assistant needs your choice"
        case .smartHomeCard:
            content.title = "Smart Home"
        default:
            content.title = "AI Assistant"
        }

        content.body = message.content
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: message.id.uuidString,
            content: content,
            trigger: nil // Fire immediately
        )

        UNUserNotificationCenter.current().add(request)
    }

    /// Clear all delivered notifications
    static func clearAll() {
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }
}
