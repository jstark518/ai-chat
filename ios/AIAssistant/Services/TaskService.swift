import Foundation

@Observable
final class TaskService {
    private let baseURL = URL(string: Config.apiBaseURL)!

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()
    private let encoder: JSONEncoder = JSONEncoder()

    var tasks: [KanbanTask] = []
    var loading = false
    var lastError: String?

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let url = baseURL.appendingPathComponent("/api/tasks")
            let (data, _) = try await URLSession.shared.data(from: url)
            let decoded = try decoder.decode([KanbanTask].self, from: data)
            await MainActor.run {
                self.tasks = decoded.sorted {
                    if $0.status == $1.status { return $0.sortOrder < $1.sortOrder }
                    return $0.status.rawValue < $1.status.rawValue
                }
                self.lastError = nil
            }
        } catch {
            await MainActor.run { self.lastError = String(describing: error) }
        }
    }

    @MainActor
    func add(title: String, status: KanbanTask.Status = .todo) async {
        let url = baseURL.appendingPathComponent("/api/tasks")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ["title": title, "status": status.rawValue]
        request.httpBody = try? encoder.encode(body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let task = try decoder.decode(KanbanTask.self, from: data)
            if !tasks.contains(where: { $0.id == task.id }) {
                tasks.append(task)
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    @MainActor
    func update(id: String, title: String? = nil, status: KanbanTask.Status? = nil) async {
        // Optimistic update
        if let idx = tasks.firstIndex(where: { $0.id == id }) {
            if let title = title { tasks[idx].title = title }
            if let status = status { tasks[idx].status = status }
        }

        let url = baseURL.appendingPathComponent("/api/tasks/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = [:]
        if let title = title { body["title"] = title }
        if let status = status { body["status"] = status.rawValue }
        request.httpBody = try? encoder.encode(body)
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let updated = try decoder.decode(KanbanTask.self, from: data)
            if let idx = tasks.firstIndex(where: { $0.id == updated.id }) {
                tasks[idx] = updated
            }
        } catch {
            lastError = String(describing: error)
        }
    }

    @MainActor
    func delete(id: String) async {
        tasks.removeAll { $0.id == id }
        let url = baseURL.appendingPathComponent("/api/tasks/\(id)")
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        _ = try? await URLSession.shared.data(for: request)
    }

    func tasks(in status: KanbanTask.Status) -> [KanbanTask] {
        tasks.filter { $0.status == status }.sorted { $0.sortOrder < $1.sortOrder }
    }
}
