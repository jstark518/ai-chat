import SwiftUI

struct MessageBubbleView: View {
    let message: Message
    var selectedOption: String?
    var onOptionSelected: ((String) -> Void)?
    var onDeviceControl: ((String, String, [String: Any]) -> Void)?

    private var isUser: Bool { message.role == .user }
    private var isAnswered: Bool { selectedOption != nil }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 60) }

            switch message.type {
            case .question:
                questionBubble
            case .multipleChoice:
                multipleChoiceBubble
            case .smartHomeCard:
                SmartHomeCardView(message: message, onDeviceControl: onDeviceControl)
            case .deviceAction:
                deviceActionBubble
            case .text:
                textBubble
            }

            if !isUser { Spacer(minLength: 60) }
        }
    }

    private var textBubble: some View {
        let urls = extractURLs(from: message.content)
        return VStack(alignment: .leading, spacing: 8) {
            Text(message.content)
                .foregroundStyle(isUser ? .white : .primary)
                .textSelection(.enabled)

            // Link previews for any URLs in the message
            if !urls.isEmpty && !isUser {
                ForEach(urls.prefix(2), id: \.self) { url in
                    LinkPreviewView(url: url)
                }
            }
        }
        .padding(12)
        .background(isUser ? Color.blue : Color(.systemGray5))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var deviceActionBubble: some View {
        HStack(spacing: 6) {
            Image(systemName: "gearshape.fill")
                .font(.caption2)
            Text(message.content)
                .font(.caption)
        }
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
        .padding(.horizontal, 10)
        .background(Color(.systemGray6))
        .clipShape(Capsule())
    }

    private var questionBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "questionmark.circle.fill")
                .font(.title3)
                .foregroundStyle(.white)

            Text(message.content)
                .foregroundStyle(.white)
                .textSelection(.enabled)
        }
        .padding(12)
        .background(Color.indigo)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var multipleChoiceBubble: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "list.bullet.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.white)

                Text(message.content)
                    .foregroundStyle(.white)
                    .textSelection(.enabled)
            }

            if let options = message.options {
                VStack(spacing: 6) {
                    ForEach(options, id: \.self) { option in
                        let isSelected = selectedOption == option

                        Button {
                            if !isAnswered {
                                onOptionSelected?(option)
                            }
                        } label: {
                            HStack {
                                Text(option)
                                Spacer()
                                if isSelected {
                                    Image(systemName: "checkmark.circle.fill")
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .padding(.horizontal, 12)
                            .background(isSelected ? .white.opacity(0.4) : .white.opacity(0.15))
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .disabled(isAnswered)
                        .opacity(isAnswered && !isSelected ? 0.5 : 1.0)
                    }
                }
            }
        }
        .padding(12)
        .background(Color.indigo)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

#Preview {
    VStack(spacing: 12) {
        MessageBubbleView(message: Message(role: .user, content: "Hello!"))
        MessageBubbleView(message: Message(role: .assistant, content: "Hi there!"))
        MessageBubbleView(message: Message(role: .assistant, content: "What are you working on?", type: .question))
        MessageBubbleView(
            message: Message(
                role: .assistant,
                content: "How would you like me to check in?",
                type: .multipleChoice,
                options: ["Every 15 minutes", "Every hour", "Only when needed"]
            )
        )
        MessageBubbleView(
            message: Message(
                role: .assistant,
                content: "How's your energy?",
                type: .multipleChoice,
                options: ["High", "Medium", "Low"]
            ),
            selectedOption: "High"
        )
    }
    .padding()
}
