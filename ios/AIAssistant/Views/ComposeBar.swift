import SwiftUI

struct ComposeBar: View {
    @Binding var text: String
    var onSend: () -> Void
    @State private var sendPulse = false
    @FocusState private var isFocused: Bool

    private var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var charCount: Int {
        text.count
    }

    private let maxCharCount = 2000

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                // Auto-expanding text field
                TextField("Message", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($isFocused)
                    .submitLabel(.send)
                    .onSubmit {
                        triggerSend()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 18))

                // Send button with pulse animation
                Button {
                    triggerSend()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title)
                        .foregroundStyle(isEmpty ? .gray : .blue)
                        .scaleEffect(sendPulse ? 1.2 : 1.0)
                }
                .disabled(isEmpty)
                .animation(.spring(response: 0.3, dampingFraction: 0.5), value: sendPulse)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            // Character count (only shows near limit)
            if charCount > maxCharCount - 200 {
                HStack {
                    Spacer()
                    Text("\(charCount) / \(maxCharCount)")
                        .font(.caption2)
                        .foregroundStyle(charCount > maxCharCount ? .red : .secondary)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 4)
                }
            }
        }
    }

    private func triggerSend() {
        guard !isEmpty else { return }
        HapticManager.medium()
        sendPulse = true
        onSend()
        // Keep focus on the text field after sending
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            isFocused = true
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            sendPulse = false
        }
    }
}

#Preview {
    @Previewable @State var text = ""
    ComposeBar(text: $text, onSend: {})
}
