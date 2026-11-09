import { t } from "../../i18n";
import { useAppStore } from "../../store/appStore";
import { ProjectTab } from "./ProjectTab";
import { TasksTab } from "./TasksTab";

/** Right panel (03 section 9): Tasks / Project tabs. */
export function SidePanel() {
  const tab = useAppStore((s) => s.sidePanelTab);
  const setTab = useAppStore((s) => s.setSidePanelTab);
  const hasDoc = useAppStore((s) => s.doc !== null);
  if (!hasDoc) return null;
  return (
    <div className="panel">
      <div className="panel-tabs" role="tablist">
        {(["tasks", "project"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : undefined}
            data-testid={`panel-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {t(id === "tasks" ? "panel.tabTasks" : "panel.tabProject")}
          </button>
        ))}
      </div>
      <div className="panel-body">{tab === "tasks" ? <TasksTab /> : <ProjectTab />}</div>
    </div>
  );
}
