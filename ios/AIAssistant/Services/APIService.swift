import Foundation

final class APIService: Sendable {
    static let shared = APIService()

    private let baseURL = URL(string: Config.apiBaseURL)!

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    private init() {}

    func fetchMessages() async throws -> [Message] {
        let url = baseURL.appendingPathComponent("/api/messages")
        let (data, _) = try await URLSession.shared.data(from: url)
        return try decoder.decode([Message].self, from: data)
    }

    func sendLocation(latitude: Double, longitude: Double) async throws {
        let url = baseURL.appendingPathComponent("/api/location")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ["latitude": latitude, "longitude": longitude]
        request.httpBody = try JSONEncoder().encode(body)
        let (_, _) = try await URLSession.shared.data(for: request)
    }
}
