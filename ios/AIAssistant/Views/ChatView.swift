import SwiftUI

struct ChatView: View {
    @State private var messages: [Message] = []
    @State private var inputText = ""
    @State private var webSocketService = WebSocketService()
    @State private var locationService = LocationService()
    @State private var multipleChoiceMessage: Message?
    @State private var isAssistantTyping = false
    @State private var readMessageIds: Set<String> = []
    @State private var selectedOptions: [UUID: String] = [:]
    @State private var replyContext: [UUID: Message] = [:]
    @State private var searchQuery = ""
    @State private var showSearch = false
    @State private var showSettings = false
    @State private var showMessageDetail: Message?
    @State private var isRefreshing = false
    @State private var isSyncing = false

    private var filteredMessages: [Message] {
        guard !searchQuery.isEmpty else { return messages }
        return messages.filter { $0.content.localizedCaseInsensitiveContains(searchQuery) }
    }

    private var groups: [UUID: MessageGroup] {
        computeMessageGroups(messages)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if showSearch {
                    searchBar
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(filteredMessages) { message in
                                messageRow(for: message, group: groups[message.id])
                                    .id(message.id)
                            }

                            if isAssistantTyping {
                                TypingIndicatorView()
                                    .id("typing-indicator")
                                    .transition(.opacity)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .refreshable {
                        await loadHistory()
                    }
                    .onChange(of: messages.count) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            scrollToBottom(proxy: proxy)
                        }
                    }
                    .onChange(of: isAssistantTyping) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            scrollToBottom(proxy: proxy)
                        }
                    }
                    .onChange(of: messages.last?.id) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                            scrollToBottom(proxy: proxy)
                        }
                    }
                }

                // Quick actions (only when input is empty and not searching)
                if inputText.isEmpty && !showSearch {
                    QuickActionsBar(onActionTapped: { msg in
                        sendMessage(text: msg)
                    })
                    .transition(.opacity)
                }

                ComposeBar(text: $inputText, onSend: { sendMessage() })
            }
            .background(Color(.systemBackground))
            .navigationTitle("AI Assistant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    ConnectionStatusView(
                        status: webSocketService.status,
                        isSyncing: isSyncing,
                        onTap: { syncMessages() }
                    )
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button { withAnimation { showSearch.toggle() } } label: {
                            Label(showSearch ? "Hide Search" : "Search", systemImage: "magnifyingglass")
                        }
                        Button { showSettings = true } label: {
                            Label("Settings", systemImage: "gearshape")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .task {
                await NotificationManager.requestPermission()
                locationService.requestPermission()
                await loadHistory()
                await connectWebSocket()
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(onClearHistory: {
                    messages.removeAll()
                    selectedOptions.removeAll()
                    replyContext.removeAll()
                    readMessageIds.removeAll()
                })
            }
            .sheet(item: $showMessageDetail) { message in
                MessageDetailView(message: message)
            }
            .confirmationDialog(
                multipleChoiceMessage?.content ?? "",
                isPresented: Binding(
                    get: { multipleChoiceMessage != nil },
                    set: { if !$0 { multipleChoiceMessage = nil } }
                ),
                titleVisibility: .visible
            ) {
                if let options = multipleChoiceMessage?.options {
                    ForEach(options, id: \.self) { option in
                        Button(option) {
                            if let mcMsg = multipleChoiceMessage {
                                selectOption(option, for: mcMsg)
                            }
                            multipleChoiceMessage = nil
                        }
                    }
                }
                Button("Cancel", role: .cancel) {
                    multipleChoiceMessage = nil
                }
            }
        }
    }

    @ViewBuilder
    private var searchBar: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search messages", text: $searchQuery)
                .textFieldStyle(.plain)
            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(8)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.systemBackground))
    }

    @ViewBuilder
    private func messageRow(for message: Message, group: MessageGroup?) -> some View {
        let showTimestamp = group?.showTimestamp ?? true
        let isLast = group?.isLastInGroup ?? true

        VStack(spacing: 2) {
            if showTimestamp {
                Text(formatGroupTimestamp(message.timestamp))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
            }

            if message.type == .deviceAction {
                HStack {
                    Spacer()
                    MessageBubbleView(message: message)
                    Spacer()
                }
            } else {
                VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 2) {
                    // Reply context for user messages
                    if message.role == .user, let repliedTo = replyContext[message.id] {
                        HStack(spacing: 4) {
                            Image(systemName: "arrowshape.turn.up.left.fill")
                                .font(.caption2)
                            Text(repliedTo.content)
                                .lineLimit(1)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                    }

                    MessageBubbleView(
                        message: message,
                        selectedOption: selectedOptions[message.id],
                        onOptionSelected: { option in
                            selectOption(option, for: message)
                        },
                        onDeviceControl: { deviceId, action, params in
                            controlDevice(deviceId: deviceId, action: action, params: params)
                        }
                    )
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = message.content
                            HapticManager.success()
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                        Button {
                            showMessageDetail = message
                        } label: {
                            Label("Details", systemImage: "info.circle")
                        }
                    }

                    // Read receipt only on last message in group
                    if message.role == .user && isLast {
                        Text(readMessageIds.contains(message.id.uuidString.uppercased()) ? "Read" : "Delivered")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                    }
                }
            }
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation {
            if isAssistantTyping {
                proxy.scrollTo("typing-indicator", anchor: .bottom)
            } else if let last = messages.last {
                proxy.scrollTo(last.id, anchor: .bottom)
            }
        }
    }

    private func controlDevice(deviceId: String, action: String, params: [String: Any]) {
        HapticManager.light()
        updateDeviceInCards(deviceId: deviceId, state: params)
        webSocketService.sendDeviceControl(deviceId: deviceId, action: action, params: params)

        let deviceName = messages
            .compactMap { $0.devices }
            .flatMap { $0 }
            .first { $0.id == deviceId }?
            .name ?? deviceId

        let description: String
        switch action {
        case "toggle", "power":
            let on = params["on"] as? Bool ?? false
            description = "\(deviceName) turned \(on ? "on" : "off")"
        case "brightness":
            let level = params["brightness"] as? Int ?? 0
            description = "\(deviceName) brightness set to \(level)%"
        case "lock":
            let locked = params["locked"] as? Bool ?? false
            description = "\(deviceName) \(locked ? "locked" : "unlocked")"
        default:
            description = "\(deviceName) updated"
        }

        let statusMessage = Message(role: .user, content: description, type: .deviceAction)
        messages.append(statusMessage)
    }

    private func updateDeviceInCards(deviceId: String, state: [String: Any]) {
        for i in messages.indices {
            guard messages[i].type == .smartHomeCard,
                  let devices = messages[i].devices else { continue }
            for j in devices.indices {
                if devices[j].id == deviceId {
                    if let on = state["on"] as? Bool {
                        messages[i].devices?[j].on = on
                    }
                    if let brightness = state["brightness"] as? Int {
                        messages[i].devices?[j].brightness = brightness
                    }
                    if let locked = state["locked"] as? Bool {
                        messages[i].devices?[j].locked = locked
                    }
                    if let targetTemp = state["targetTemp"] as? Double {
                        messages[i].devices?[j].targetTemp = targetTemp
                    }
                    if let mode = state["mode"] as? String {
                        messages[i].devices?[j].mode = mode
                    }
                    if let sensorState = state["state"] as? String {
                        messages[i].devices?[j].state = sensorState
                    }
                }
            }
        }
    }

    private func selectOption(_ option: String, for questionMessage: Message) {
        HapticManager.light()
        withAnimation {
            selectedOptions[questionMessage.id] = option
        }
        sendMessage(text: option, replyTo: questionMessage)
    }

    private func sendMessage(text: String? = nil, replyTo: Message? = nil) {
        let content = text ?? inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }

        let message = Message(role: .user, content: content)
        messages.append(message)
        if text == nil { inputText = "" }

        if let replyTo {
            replyContext[message.id] = replyTo
        }

        webSocketService.send(message)
    }

    private func sendReadReceipt(for message: Message) {
        guard message.role == .assistant else { return }
        webSocketService.sendReadReceipt(messageIds: [message.id.uuidString])
    }

    private func loadHistory() async {
        do {
            let history = try await APIService.shared.fetchMessages()
            mergeMessages(history)
            let assistantIds = messages.filter { $0.role == .assistant }.map { $0.id.uuidString }
            if !assistantIds.isEmpty {
                webSocketService.sendReadReceipt(messageIds: assistantIds)
            }
        } catch {
            print("Failed to load history: \(error)")
        }
    }

    private func syncMessages() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        guard !isSyncing else { return }
        isSyncing = true
        HapticManager.light()
        Task {
            async let fetch: () = loadHistory()
            async let minDelay: () = Task.sleep(for: .seconds(2))
            await fetch
            try? await minDelay
            isSyncing = false
        }
    }

    private func mergeMessages(_ incoming: [Message]) {
        let existingIds = Set(messages.map { $0.id })
        let newMessages = incoming.filter { !existingIds.contains($0.id) }
        if newMessages.isEmpty && messages.count == incoming.count {
            // Full refresh (initial load or no local-only messages)
            messages = incoming
        } else if !newMessages.isEmpty {
            messages.append(contentsOf: newMessages)
            messages.sort { $0.timestamp < $1.timestamp }
        }
    }

    private func connectWebSocket() async {
        for await event in webSocketService.incoming {
            switch event {
            case .message(let message):
                withAnimation {
                    isAssistantTyping = false
                }
                guard !messages.contains(where: { $0.id == message.id }) else { continue }
                messages.append(message)

                // Haptic + notification for incoming assistant messages
                if message.role == .assistant {
                    switch message.type {
                    case .question, .multipleChoice:
                        HapticManager.warning()
                    default:
                        HapticManager.soft()
                    }
                    NotificationManager.showMessageNotification(message)
                }

                if message.type == .multipleChoice {
                    multipleChoiceMessage = message
                }

                sendReadReceipt(for: message)

            case .typing(let typing):
                withAnimation {
                    isAssistantTyping = typing
                }

            case .read(let ids):
                withAnimation {
                    readMessageIds.formUnion(ids.map { $0.uppercased() })
                }

            case .deviceStateUpdate(let deviceId, let state):
                updateDeviceInCards(deviceId: deviceId, state: state)

            case .requestLocation(let requestId):
                locationService.fetchOnce { [webSocketService] loc in
                    if let loc {
                        webSocketService.sendLocationResponse(
                            requestId: requestId,
                            latitude: loc.coordinate.latitude,
                            longitude: loc.coordinate.longitude
                        )
                    }
                }

            case .reconnected:
                await loadHistory()
            }
        }
    }
}

// MARK: - Message Detail

struct MessageDetailView: View {
    let message: Message
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Content") {
                    Text(message.content)
                        .textSelection(.enabled)
                }
                Section("Details") {
                    LabeledContent("ID", value: message.id.uuidString)
                    LabeledContent("Role", value: message.role.rawValue.capitalized)
                    LabeledContent("Type", value: message.type.rawValue)
                    LabeledContent("Sent", value: message.timestamp.formatted(date: .abbreviated, time: .standard))
                }
                if let devices = message.devices, !devices.isEmpty {
                    Section("Devices") {
                        ForEach(devices) { d in
                            Text("\(d.name) (\(d.deviceType.rawValue))")
                                .font(.caption)
                        }
                    }
                }
            }
            .navigationTitle("Message Details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    ChatView()
}
