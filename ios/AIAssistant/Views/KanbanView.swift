import SwiftUI

struct KanbanView: View {
    @State private var service = TaskService()
    @State private var newTitleByStatus: [KanbanTask.Status: String] = [
        .todo: "", .doing: "", .done: ""
    ]
    @State private var editingTask: KanbanTask?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    ForEach(KanbanTask.Status.allCases, id: \.self) { status in
                        columnView(for: status)
                    }
                }
                .padding()
            }
            .navigationTitle("Tasks")
            .navigationBarTitleDisplayMode(.large)
            .refreshable { await service.load() }
            .task { await service.load() }
            .sheet(item: $editingTask) { task in
                EditTaskSheet(task: task, service: service) { editingTask = nil }
            }
        }
    }

    @ViewBuilder
    private func columnView(for status: KanbanTask.Status) -> some View {
        let tasks = service.tasks(in: status)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(status.label.uppercased())
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(colorForStatus(status))
                Text("\(tasks.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
            }

            VStack(spacing: 6) {
                ForEach(tasks) { task in
                    taskCard(task)
                }

                HStack {
                    TextField("+ Add task", text: Binding(
                        get: { newTitleByStatus[status] ?? "" },
                        set: { newTitleByStatus[status] = $0 }
                    ))
                    .textFieldStyle(.plain)
                    .font(.subheadline)
                    .padding(8)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .onSubmit { submitNew(status: status) }
                }
            }
        }
        .padding(12)
        .background(Color(.systemGray6).opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private func taskCard(_ task: KanbanTask) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text(task.title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                if let description = task.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            Menu {
                ForEach(KanbanTask.Status.allCases, id: \.self) { s in
                    if s != task.status {
                        Button("Move to \(s.label)") {
                            Task { await service.update(id: task.id, status: s) }
                        }
                    }
                }
                Divider()
                Button("Edit") { editingTask = task }
                Button("Delete", role: .destructive) {
                    Task { await service.delete(id: task.id) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(6)
            }
        }
        .padding(10)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(.systemGray5), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { editingTask = task }
    }

    private func submitNew(status: KanbanTask.Status) {
        let title = (newTitleByStatus[status] ?? "").trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        newTitleByStatus[status] = ""
        Task { await service.add(title: title, status: status) }
    }

    private func colorForStatus(_ status: KanbanTask.Status) -> Color {
        switch status {
        case .todo: return .secondary
        case .doing: return .blue
        case .done: return .green
        }
    }
}

private struct EditTaskSheet: View {
    let task: KanbanTask
    let service: TaskService
    let onDismiss: () -> Void

    @State private var title: String
    @State private var status: KanbanTask.Status

    init(task: KanbanTask, service: TaskService, onDismiss: @escaping () -> Void) {
        self.task = task
        self.service = service
        self.onDismiss = onDismiss
        _title = State(initialValue: task.title)
        _status = State(initialValue: task.status)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Title") {
                    TextField("Title", text: $title)
                }
                Section("Column") {
                    Picker("Column", selection: $status) {
                        ForEach(KanbanTask.Status.allCases, id: \.self) { s in
                            Text(s.label).tag(s)
                        }
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Edit Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onDismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            await service.update(
                                id: task.id,
                                title: title != task.title ? title : nil,
                                status: status != task.status ? status : nil
                            )
                            onDismiss()
                        }
                    }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

#Preview {
    KanbanView()
}
