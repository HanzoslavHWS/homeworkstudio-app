"use client";

import { useState } from "react";
import {
  buildMonthGrid,
  buildWeekDays,
  CZECH_MONTHS,
  CZECH_WEEKDAYS_SHORT,
  groupCalendarItems,
  shiftCalendarAnchor,
  type CalendarMode,
  type EventMilestone,
} from "../../../domain/taskCalendar";
import { formatShortDate, isTaskOpen, isoWeekday, type Task } from "../../../domain/tasks";

const MONTH_CELL_LIMIT = 4;
const DRAG_TYPE = "application/x-homeworkstudio-task-id";

/**
 * Month / week / day calendar of tasks (by due date) and event milestones (derived from events,
 * drawn as ◆ markers — visually distinct from tasks). Open tasks can be dragged onto another day to
 * change their due date; clicking a task opens its detail, clicking a milestone opens its event.
 */
export function TaskCalendar({
  tasks,
  milestones,
  today,
  onOpenTask,
  onOpenMilestone,
  onMoveTask,
}: {
  tasks: readonly Task[];
  milestones: readonly EventMilestone[];
  today: string;
  onOpenTask: (task: Task) => void;
  onOpenMilestone?: (milestone: EventMilestone) => void;
  onMoveTask: (task: Task, newDueDate: string) => void;
}) {
  const [mode, setMode] = useState<CalendarMode>("month");
  const [anchor, setAnchor] = useState(today);
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);
  const byDate = groupCalendarItems(tasks, milestones);
  const [year, month] = anchor.split("-").map(Number) as [number, number];

  const title = mode === "month"
    ? `${CZECH_MONTHS[month - 1]} ${year}`
    : mode === "week"
      ? (() => { const days = buildWeekDays(anchor); return `${formatShortDate(days[0]!, today)} – ${formatShortDate(days[6]!)} ${days[6]!.slice(0, 4)}`; })()
      : `${CZECH_WEEKDAYS_SHORT[isoWeekday(anchor) - 1]} ${formatShortDate(anchor)} ${anchor.slice(0, 4)}`;

  function dropProps(date: string) {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== date) setDropTarget(date);
      },
      onDragLeave: () => setDropTarget((current) => (current === date ? undefined : current)),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        setDropTarget(undefined);
        const taskId = event.dataTransfer.getData(DRAG_TYPE);
        const task = tasks.find((candidate) => candidate.id === taskId);
        if (task && task.dueDate !== date) onMoveTask(task, date);
      },
    };
  }

  function renderItems(date: string, limit?: number) {
    const day = byDate.get(date);
    if (!day) return null;
    const visibleTasks = limit ? day.tasks.slice(0, Math.max(0, limit - day.milestones.length)) : day.tasks;
    const hidden = day.tasks.length - visibleTasks.length;
    return (
      <>
        {day.milestones.map((milestone) => (
          <button key={milestone.id} type="button" className="calendarMilestone" title={`${milestone.eventName}: ${milestone.label}`} onClick={() => onOpenMilestone?.(milestone)}>
            <span aria-hidden="true">◆</span> {milestone.label} <span className="calendarMilestoneEvent">{milestone.eventName}</span>
          </button>
        ))}
        {visibleTasks.map((task) => {
          const open = isTaskOpen(task);
          const overdue = open && task.dueDate! < today;
          return (
            <button
              key={task.id}
              type="button"
              draggable={open}
              onDragStart={(event) => { event.dataTransfer.setData(DRAG_TYPE, task.id); event.dataTransfer.effectAllowed = "move"; }}
              className={["calendarTask", overdue ? "overdue" : "", open ? "" : "closed", `priority-${task.priority}`].filter(Boolean).join(" ")}
              title={[task.title, task.standNumber, task.companyName].filter(Boolean).join(" · ")}
              onClick={() => onOpenTask(task)}
            >
              {task.dueTime && <span className="calendarTaskTime">{task.dueTime}</span>}
              {!open && <span aria-label="hotovo">✓ </span>}
              {task.standNumber ? `${task.standNumber} · ` : ""}{task.title}
            </button>
          );
        })}
        {hidden > 0 && (
          <button type="button" className="calendarMore" onClick={() => { setAnchor(date); setMode("day"); }}>+{hidden} další</button>
        )}
      </>
    );
  }

  return (
    <div className="taskCalendar">
      <div className="taskCalendarToolbar">
        <div className="taskCalendarNav">
          <button type="button" onClick={() => setAnchor((value) => shiftCalendarAnchor(value, mode, -1))} aria-label="Předchozí">‹</button>
          <button type="button" onClick={() => setAnchor(today)}>Dnes</button>
          <button type="button" onClick={() => setAnchor((value) => shiftCalendarAnchor(value, mode, 1))} aria-label="Další">›</button>
          <strong>{title}</strong>
        </div>
        <div className="taskTabs compact" role="tablist" aria-label="Pohled kalendáře">
          {(["month", "week", "day"] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={mode === value} className={mode === value ? "taskTab active" : "taskTab"} onClick={() => setMode(value)}>
              {value === "month" ? "Měsíc" : value === "week" ? "Týden" : "Den"}
            </button>
          ))}
        </div>
      </div>
      <p className="fieldHint taskCalendarLegend"><span className="calendarMilestone legend">◆ Milník akce</span> Úkoly lze přetažením přesunout na jiný den.</p>

      {mode === "month" && (
        <div className="calendarMonth">
          {CZECH_WEEKDAYS_SHORT.map((label) => <div key={label} className="calendarWeekday">{label}</div>)}
          {buildMonthGrid(year, month).flat().map((date) => (
            <div
              key={date}
              className={["calendarCell", date.slice(5, 7) !== anchor.slice(5, 7) ? "outside" : "", date === today ? "today" : "", dropTarget === date ? "dropTarget" : ""].filter(Boolean).join(" ")}
              {...dropProps(date)}
            >
              <button type="button" className="calendarDayNumber" onClick={() => { setAnchor(date); setMode("day"); }} aria-label={`Zobrazit den ${formatShortDate(date)}`}>
                {Number(date.slice(8, 10))}
              </button>
              {renderItems(date, MONTH_CELL_LIMIT)}
            </div>
          ))}
        </div>
      )}

      {mode === "week" && (
        <div className="calendarWeek">
          {buildWeekDays(anchor).map((date, index) => (
            <div key={date} className={["calendarCell", date === today ? "today" : "", dropTarget === date ? "dropTarget" : ""].filter(Boolean).join(" ")} {...dropProps(date)}>
              <div className="calendarWeekHeader">{CZECH_WEEKDAYS_SHORT[index]} {formatShortDate(date)}</div>
              {renderItems(date)}
            </div>
          ))}
        </div>
      )}

      {mode === "day" && (
        <div className={["calendarDay", "calendarCell", dropTarget === anchor ? "dropTarget" : ""].filter(Boolean).join(" ")} {...dropProps(anchor)}>
          {byDate.get(anchor) ? renderItems(anchor) : <p className="workspaceEmpty">Na tento den není nic naplánováno.</p>}
        </div>
      )}
    </div>
  );
}
