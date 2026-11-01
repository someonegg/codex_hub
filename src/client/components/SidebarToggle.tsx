import { t } from "../i18n";

export function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = t(collapsed ? "expandSidebar" : "collapseSidebar");
  return (
    <button
      className="hub-sidebar-toggle"
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls="hub-sidebar"
      onClick={onToggle}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
        <path d={collapsed ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"} />
      </svg>
    </button>
  );
}
