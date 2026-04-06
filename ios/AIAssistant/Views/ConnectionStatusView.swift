import SwiftUI

struct ConnectionStatusView: View {
    let status: ConnectionStatus
    var isSyncing: Bool = false
    var onTap: (() -> Void)?

    var body: some View {
        Button {
            onTap?()
        } label: {
            HStack(spacing: 4) {
                if isSyncing {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 7, height: 7)
                        .overlay(
                            Circle()
                                .stroke(dotColor.opacity(0.3), lineWidth: 2)
                                .scaleEffect(status == .connecting || status == .reconnecting ? 2 : 1)
                                .opacity(status == .connecting || status == .reconnecting ? 0 : 1)
                                .animation(
                                    .easeOut(duration: 1).repeatForever(autoreverses: false),
                                    value: status
                                )
                        )
                }
                Text(isSyncing ? "Syncing..." : label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
    }

    private var dotColor: Color {
        switch status {
        case .connected: return .green
        case .connecting, .reconnecting: return .yellow
        case .disconnected: return .red
        }
    }

    private var label: String {
        switch status {
        case .connected: return "Online"
        case .connecting: return "Connecting..."
        case .reconnecting: return "Reconnecting..."
        case .disconnected: return "Offline"
        }
    }
}

#Preview {
    VStack(spacing: 20) {
        ConnectionStatusView(status: .connected)
        ConnectionStatusView(status: .connecting)
        ConnectionStatusView(status: .reconnecting)
        ConnectionStatusView(status: .disconnected)
        ConnectionStatusView(status: .connected, isSyncing: true)
    }
    .padding()
}
