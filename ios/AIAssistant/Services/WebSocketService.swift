import Foundation

enum WSIncoming {
    case message(Message)
    case typing(Bool)
    case read(Set<String>)
    case deviceStateUpdate(deviceId: String, state: [String: Any])
    case requestLocation(requestId: String)
}

enum ConnectionStatus {
    case connecting
    case connected
    case disconnected
    case reconnecting
}

@Observable
final class WebSocketService {
    private var webSocketTask: URLSessionWebSocketTask?
    private var continuation: AsyncStream<WSIncoming>.Continuation?

    var status: ConnectionStatus = .disconnected

    private let url = URL(string: Config.webSocketURL)!

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()

    var incoming: AsyncStream<WSIncoming> {
        AsyncStream { continuation in
            self.continuation = continuation
            connect()
        }
    }

    private func connect() {
        DispatchQueue.main.async { self.status = .connecting }
        let task = URLSession.shared.webSocketTask(with: url)
        self.webSocketTask = task
        task.resume()
        DispatchQueue.main.async { self.status = .connected }
        receiveLoop()
    }

    private func receiveLoop() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let wsMessage):
                if case .string(let text) = wsMessage,
                   let data = text.data(using: .utf8) {
                    self.handleIncoming(data)
                }
                self.receiveLoop()
            case .failure:
                self.reconnect()
            }
        }
    }

    private func handleIncoming(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        // Handle events
        if let event = json["event"] as? String {
            switch event {
            case "typing":
                if let typing = json["typing"] as? Bool {
                    continuation?.yield(.typing(typing))
                }
            case "read":
                if let ids = json["messageIds"] as? [String] {
                    continuation?.yield(.read(Set(ids)))
                }
            case "device_state_update":
                if let deviceId = json["deviceId"] as? String,
                   let state = json["state"] as? [String: Any] {
                    continuation?.yield(.deviceStateUpdate(deviceId: deviceId, state: state))
                }
            case "request_location":
                if let requestId = json["requestId"] as? String {
                    continuation?.yield(.requestLocation(requestId: requestId))
                }
            default:
                break
            }
            return
        }

        // Otherwise decode as Message
        if let message = try? decoder.decode(Message.self, from: data) {
            continuation?.yield(.message(message))
        }
    }

    private func reconnect() {
        DispatchQueue.main.async { self.status = .reconnecting }
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.connect()
        }
    }

    func send(_ message: Message) {
        guard let data = try? encoder.encode(message),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("WebSocket send error: \(error)")
            }
        }
    }

    func sendReadReceipt(messageIds: [String]) {
        let payload: [String: Any] = ["event": "read", "messageIds": messageIds]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("WebSocket read receipt error: \(error)")
            }
        }
    }

    func sendDeviceControl(deviceId: String, action: String, params: [String: Any]) {
        let payload: [String: Any] = ["event": "device_control", "deviceId": deviceId, "action": action, "params": params]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("WebSocket device control error: \(error)")
            }
        }
    }

    func sendLocationResponse(requestId: String, latitude: Double, longitude: Double) {
        let payload: [String: Any] = [
            "event": "location_response",
            "requestId": requestId,
            "latitude": latitude,
            "longitude": longitude,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("WebSocket location response error: \(error)")
            }
        }
    }

    func disconnect() {
        DispatchQueue.main.async { self.status = .disconnected }
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        continuation?.finish()
    }
}
