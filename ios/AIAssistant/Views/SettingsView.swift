import SwiftUI

struct SettingsView: View {
    @AppStorage("backendURL") private var backendURL: String = "http://localhost:8136"
    @AppStorage("notificationsEnabled") private var notificationsEnabled: Bool = true
    @AppStorage("hapticFeedbackEnabled") private var hapticFeedbackEnabled: Bool = true
    @AppStorage("soundEnabled") private var soundEnabled: Bool = false

    var onClearHistory: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showClearConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    HStack {
                        Text("Backend URL")
                        Spacer()
                        TextField("http://localhost:8136", text: $backendURL)
                            .multilineTextAlignment(.trailing)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(.secondary)
                    }
                    Text("Restart the app after changing the URL")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Section("Notifications") {
                    Toggle("Enable notifications", isOn: $notificationsEnabled)
                    Toggle("Haptic feedback", isOn: $hapticFeedbackEnabled)
                    Toggle("Sound effects", isOn: $soundEnabled)
                }

                Section("Data") {
                    Button(role: .destructive) {
                        showClearConfirm = true
                    } label: {
                        HStack {
                            Image(systemName: "trash")
                            Text("Clear Local History")
                        }
                    }
                    Text("Removes cached messages. Server history is not affected.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("1.0.0").foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Clear local message history?", isPresented: $showClearConfirm, titleVisibility: .visible) {
                Button("Clear", role: .destructive) {
                    onClearHistory()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }
}

#Preview {
    SettingsView(onClearHistory: {})
}
