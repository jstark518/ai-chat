import SwiftUI

struct QuickAction: Identifiable {
    let id = UUID()
    let emoji: String
    let label: String
    let message: String
}

struct QuickActionsBar: View {
    var onActionTapped: (String) -> Void

    private let actions: [QuickAction] = [
        QuickAction(emoji: "💡", label: "Lights", message: "Show me my lights"),
        QuickAction(emoji: "🌡️", label: "Temp", message: "What's the thermostat set to?"),
        QuickAction(emoji: "🔒", label: "Locks", message: "Are my doors locked?"),
        QuickAction(emoji: "🌙", label: "Good night", message: "Good night"),
        QuickAction(emoji: "☀️", label: "Good morning", message: "Good morning"),
        QuickAction(emoji: "📊", label: "Status", message: "Give me a quick home status update"),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(actions) { action in
                    Button {
                        HapticManager.light()
                        onActionTapped(action.message)
                    } label: {
                        HStack(spacing: 4) {
                            Text(action.emoji)
                                .font(.caption)
                            Text(action.label)
                                .font(.caption)
                                .fontWeight(.medium)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color(.systemGray6))
                        .foregroundStyle(.primary)
                        .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}

#Preview {
    QuickActionsBar(onActionTapped: { _ in })
}
