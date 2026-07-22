import { NavLink, useLocation } from "react-router-dom";
import { useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  Cpu,
  Key,
  Activity,
  BarChart3,
  Sliders,
  Bot,
  CreditCard,
  Globe,
  Sparkles,
  Filter,
  Plug,
  LogOut,
  X,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useWsStatus } from "@/hooks/useWebSocket";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

const navSections: NavSection[] = [
  {
    title: "ACCOUNTS",
    items: [
      { label: "Dashboard", path: "/", icon: LayoutDashboard },
      { label: "Accounts", path: "/accounts", icon: Users },
      { label: "Models", path: "/models", icon: Cpu },
    ],
  },
  {
    title: "TOOLS",
    items: [
      { label: "Image Studio", path: "/image-studio", icon: Sparkles },
      { label: "Integration", path: "/integration", icon: Plug },
    ],
  },
  {
    title: "PROXY",
    items: [
      { label: "API Key", path: "/api-key", icon: Key },
      { label: "Proxy Pool", path: "/proxy-pool", icon: Globe },
      { label: "VCC Pool", path: "/vcc-pool", icon: CreditCard },
      { label: "Filter Rules", path: "/filter-rules", icon: Filter },
      { label: "Proxy Settings", path: "/settings", icon: Sliders },
    ],
  },
  {
    title: "LOGS & ANALYTICS",
    items: [
      { label: "Requests", path: "/requests", icon: Activity },
      { label: "Login Logs", path: "/bot-logs", icon: Bot },
      { label: "Usage", path: "/usage", icon: BarChart3 },
    ],
  },
];

interface SidebarProps {
  onLogout?: () => void;
  open?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ onLogout, open, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const wsStatus = useWsStatus();

  useEffect(() => {
    onClose?.();
  }, [location.pathname]);

  const wsMeta =
    wsStatus === "open"
      ? { color: "var(--gold)", label: "Live", pulse: true }
      : wsStatus === "connecting"
        ? { color: "var(--warning)", label: "Connecting", pulse: false }
        : { color: "var(--error)", label: "Offline", pulse: false };

  return (
    <aside
      className={cn(
        "fixed top-0 left-0 z-50 flex h-screen flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar-bg)] transition-all duration-200",
        collapsed ? "w-[64px]" : "w-[240px]",
        open ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}
    >
      <div
        className={cn(
          "relative border-b border-[var(--sidebar-border)] p-4",
          collapsed ? "flex items-center justify-center" : "flex items-center justify-between"
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-primary font-heading text-xs font-bold text-white shadow-[var(--glow)]">
            E
          </div>
          {!collapsed && (
            <div>
              <h1 className="font-heading text-sm font-bold tracking-tight text-[var(--foreground)]">
                Etteum
              </h1>
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--muted-foreground)]">
                <span className="relative flex h-1.5 w-1.5">
                  {wsMeta.pulse ? (
                    <span
                      className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                      style={{ backgroundColor: wsMeta.color }}
                    />
                  ) : null}
                  <span
                    className="relative inline-flex h-1.5 w-1.5 rounded-full"
                    style={{
                      backgroundColor: wsMeta.color,
                      boxShadow: `0 0 8px ${wsMeta.color}`,
                    }}
                  />
                </span>
                {wsMeta.label}
              </span>
            </div>
          )}
        </div>
        {onClose && !collapsed && (
          <button
            onClick={onClose}
            className="rounded-full p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)] md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}

        <button
          onClick={onToggleCollapse}
          className="absolute -right-3 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm transition-colors hover:border-[var(--primary)]/50 hover:text-[var(--foreground)] md:flex"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </div>

      <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2" : "px-3")}>
        {navSections.map((section) => (
          <div key={section.title} className="mb-6">
            {!collapsed && (
              <h2 className="mb-2 px-3 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                {section.title}
              </h2>
            )}
            <ul className="space-y-1">
              {section.items.map((item) => (
                <li key={item.path}>
                  <NavLink
                    to={item.path}
                    end={item.path === "/"}
                    className={({ isActive }) =>
                      cn(
                        "flex items-center gap-3 text-sm transition-all duration-200",
                        collapsed ? "justify-center rounded-full px-2 py-2" : "rounded-full px-3 py-2",
                        isActive
                          ? "bg-gradient-primary font-semibold text-white shadow-[var(--glow)]"
                          : "text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
                      )
                    }
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!collapsed && item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn("space-y-1 border-t border-[var(--sidebar-border)] p-3", collapsed && "px-2")}>
        <button
          onClick={toggleTheme}
          className={cn(
            "flex w-full items-center gap-3 rounded-full text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)]",
            collapsed ? "justify-center px-2 py-2" : "px-3 py-2"
          )}
          aria-label="Toggle theme"
          title={collapsed ? (theme === "dark" ? "Light Mode" : "Dark Mode") : undefined}
        >
          {theme === "dark" ? <Sun className="h-4 w-4 shrink-0" /> : <Moon className="h-4 w-4 shrink-0" />}
          {!collapsed && (theme === "dark" ? "Light Mode" : "Dark Mode")}
        </button>
        {onLogout && (
          <button
            onClick={onLogout}
            className={cn(
              "flex w-full items-center gap-3 rounded-full text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--destructive)]/10 hover:text-[var(--destructive)]",
              collapsed ? "justify-center px-2 py-2" : "px-3 py-2"
            )}
            title={collapsed ? "Logout" : undefined}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && "Logout"}
          </button>
        )}
      </div>
    </aside>
  );
}
