import Foundation

struct MessageGroup {
    /// True if this message should show its timestamp (start of a new group)
    let showTimestamp: Bool
    /// True if this message is the last in its group (bubble gets read receipt / footer)
    let isLastInGroup: Bool
}

/// Determines grouping: consecutive messages from the same sender within 60 seconds are grouped.
func computeMessageGroups(_ messages: [Message]) -> [UUID: MessageGroup] {
    var result: [UUID: MessageGroup] = [:]

    for (i, message) in messages.enumerated() {
        let prev = i > 0 ? messages[i - 1] : nil
        let next = i < messages.count - 1 ? messages[i + 1] : nil

        // Show timestamp if: first message, or sender changed, or >60s since previous
        let showTimestamp: Bool
        if let prev {
            let sameRole = prev.role == message.role
            let timeDelta = message.timestamp.timeIntervalSince(prev.timestamp)
            showTimestamp = !sameRole || timeDelta > 300 // 5 minutes
        } else {
            showTimestamp = true
        }

        // Last in group if: last message, or sender changed, or >60s until next
        let isLastInGroup: Bool
        if let next {
            let sameRole = next.role == message.role
            let timeDelta = next.timestamp.timeIntervalSince(message.timestamp)
            isLastInGroup = !sameRole || timeDelta > 60
        } else {
            isLastInGroup = true
        }

        result[message.id] = MessageGroup(showTimestamp: showTimestamp, isLastInGroup: isLastInGroup)
    }

    return result
}

/// Format a date for display at the start of a message group.
func formatGroupTimestamp(_ date: Date) -> String {
    let calendar = Calendar.current
    let now = Date()

    if calendar.isDateInToday(date) {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    } else if calendar.isDateInYesterday(date) {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return "Yesterday " + formatter.string(from: date)
    } else if let days = calendar.dateComponents([.day], from: date, to: now).day, days < 7 {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE h:mm a"
        return formatter.string(from: date)
    } else {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d, h:mm a"
        return formatter.string(from: date)
    }
}
