import Foundation

struct KanbanTask: Identifiable, Codable, Equatable {
    let id: String
    var title: String
    var description: String?
    var status: Status
    var sortOrder: Int
    let createdAt: String
    var updatedAt: String

    enum Status: String, Codable, CaseIterable {
        case todo
        case doing
        case done

        var label: String {
            switch self {
            case .todo: return "To Do"
            case .doing: return "Doing"
            case .done: return "Done"
            }
        }
    }
}
