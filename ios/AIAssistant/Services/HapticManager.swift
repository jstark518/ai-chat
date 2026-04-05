import UIKit

enum HapticManager {
    /// Light feedback for small interactions (button taps, selections)
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Medium feedback for confirmations (send message, toggle)
    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// Soft feedback for subtle actions (scroll, reveal)
    static func soft() {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    }

    /// Success notification (completed action)
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Warning notification (agent asking something)
    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    /// Error notification (failed action)
    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }

    /// Selection change (picker/segmented control)
    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
