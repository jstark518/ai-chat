import { useState, type DragEvent } from "react";
import { useTasks, type Task, type TaskStatus } from "../hooks/useTasks";

const COLUMNS: Array<{ id: TaskStatus; label: string; color: string }> = [
  { id: "todo", label: "To Do", color: "text-gray-400" },
  { id: "doing", label: "Doing", color: "text-blue-400" },
  { id: "done", label: "Done", color: "text-green-400" },
];

interface Props {
  /** Show in a compact mode with less padding (e.g. for the chat sidebar). */
  compact?: boolean;
}

export function KanbanBoard({ compact = false }: Props) {
  const { tasks, addTask, updateTask, deleteTask } = useTasks();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [hoverColumn, setHoverColumn] = useState<TaskStatus | null>(null);
  const [newTitleByColumn, setNewTitleByColumn] = useState<Record<TaskStatus, string>>({ todo: "", doing: "", done: "" });

  const byColumn = (status: TaskStatus) =>
    tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));

  const handleDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, status: TaskStatus) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverColumn(status);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, status: TaskStatus) => {
    e.preventDefault();
    setHoverColumn(null);
    if (!draggingId) return;
    const task = tasks.find((t) => t.id === draggingId);
    if (task && task.status !== status) {
      updateTask(draggingId, { status });
    }
    setDraggingId(null);
  };

  const handleAdd = (status: TaskStatus) => {
    const title = newTitleByColumn[status].trim();
    if (!title) return;
    addTask(title, status);
    setNewTitleByColumn((p) => ({ ...p, [status]: "" }));
  };

  return (
    <div className={`grid grid-cols-1 md:grid-cols-3 gap-${compact ? "2" : "4"}`}>
      {COLUMNS.map((col) => {
        const colTasks = byColumn(col.id);
        const isHover = hoverColumn === col.id && draggingId !== null;
        return (
          <div
            key={col.id}
            onDragOver={(e) => handleDragOver(e, col.id)}
            onDragLeave={() => setHoverColumn(null)}
            onDrop={(e) => handleDrop(e, col.id)}
            className={`bg-gray-800/50 rounded-xl border flex flex-col ${compact ? "p-2" : "p-3"} ${
              isHover ? "border-blue-500 bg-gray-800" : "border-gray-700"
            } transition-colors`}
          >
            <div className="flex items-center justify-between mb-2 px-1">
              <h3 className={`text-xs font-semibold uppercase tracking-wide ${col.color}`}>{col.label}</h3>
              <span className="text-[10px] text-gray-500">{colTasks.length}</span>
            </div>
            <div className={`space-y-${compact ? "1.5" : "2"} flex-1 min-h-[60px]`}>
              {colTasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  compact={compact}
                  dragging={draggingId === t.id}
                  onDragStart={(e) => handleDragStart(e, t.id)}
                  onDragEnd={() => { setDraggingId(null); setHoverColumn(null); }}
                  onDelete={() => deleteTask(t.id)}
                  onEdit={(title) => updateTask(t.id, { title })}
                />
              ))}
            </div>
            <div className="flex gap-1 mt-2">
              <input
                value={newTitleByColumn[col.id]}
                onChange={(e) => setNewTitleByColumn((p) => ({ ...p, [col.id]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && handleAdd(col.id)}
                placeholder="+ Add task"
                className={`flex-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 ${compact ? "text-[11px]" : "text-xs"}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  compact: boolean;
  dragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDelete: () => void;
  onEdit: (title: string) => void;
}

function TaskCard({ task, compact, dragging, onDragStart, onDragEnd, onDelete, onEdit }: TaskCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== task.title) onEdit(next);
    else setDraft(task.title);
    setEditing(false);
  };

  return (
    <div
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group bg-gray-900 border border-gray-700 rounded-lg ${compact ? "p-1.5" : "p-2"} ${
        dragging ? "opacity-30" : ""
      } hover:border-gray-600 cursor-grab active:cursor-grabbing`}
    >
      <div className="flex items-start justify-between gap-1">
        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(task.title); setEditing(false); }
            }}
            className="flex-1 bg-gray-800 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-gray-100 focus:outline-none"
          />
        ) : (
          <button
            onClick={() => setEditing(true)}
            className={`flex-1 text-left text-gray-100 ${compact ? "text-[11px]" : "text-xs"} leading-snug break-words`}
          >
            {task.title}
          </button>
        )}
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-[10px] flex-shrink-0 transition-opacity"
          title="Delete"
        >
          ✕
        </button>
      </div>
      {task.description && !editing && (
        <p className={`text-gray-500 mt-1 ${compact ? "text-[10px]" : "text-[11px]"} line-clamp-2`}>{task.description}</p>
      )}
    </div>
  );
}
