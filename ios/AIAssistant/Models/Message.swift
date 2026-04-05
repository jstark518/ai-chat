import Foundation

struct DeviceInfo: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let deviceType: DeviceType
    var room: String?
    // Light
    var on: Bool?
    var brightness: Int?
    var color: String?
    var source: String?
    // Lock
    var locked: Bool?
    // Thermostat
    var currentTemp: Double?
    var targetTemp: Double?
    var mode: String?
    var humidity: Int?
    // Sensor
    var sensorType: String?
    var state: String?
    var lastTriggered: String?

    enum DeviceType: String, Codable {
        case light
        case lock
        case thermostat
        case sensor
    }
}

struct Message: Identifiable, Codable, Equatable {
    let id: UUID
    let role: Role
    let content: String
    let type: MessageType
    let options: [String]?
    var devices: [DeviceInfo]?
    let timestamp: Date

    enum Role: String, Codable {
        case user
        case assistant
    }

    enum MessageType: String, Codable {
        case text
        case question
        case multipleChoice = "multiple_choice"
        case smartHomeCard = "smart_home_card"
        case deviceAction = "device_action"
    }

    init(id: UUID = UUID(), role: Role, content: String, type: MessageType = .text, options: [String]? = nil, devices: [DeviceInfo]? = nil, timestamp: Date = Date()) {
        self.id = id
        self.role = role
        self.content = content
        self.type = type
        self.options = options
        self.devices = devices
        self.timestamp = timestamp
    }

    // Custom decoding to handle missing fields (backward compat)
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        role = try container.decode(Role.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        type = try container.decodeIfPresent(MessageType.self, forKey: .type) ?? .text
        options = try container.decodeIfPresent([String].self, forKey: .options)
        devices = try container.decodeIfPresent([DeviceInfo].self, forKey: .devices)
        timestamp = try container.decode(Date.self, forKey: .timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case id, role, content, type, options, devices, timestamp
    }
}
