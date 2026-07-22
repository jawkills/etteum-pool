import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import { Menu } from "lucide-react";

interface LayoutProps {
  onLogout?: () => void;
}

export default function Layout({ onLogout }: LayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar-collapsed", collapsed ? "true" : "false");
    } catch {}
  }, [collapsed]);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar
        onLogout={onLogout}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />

      <main
        className={
          "h-screen overflow-y-auto bg-[var(--background)] p-4 pt-18 transition-all duration-200 md:p-6 md:pt-6 " +
          (collapsed ? "md:ml-[64px]" : "md:ml-[240px]")
        }
      >
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed top-4 left-4 z-30 rounded-full border border-[var(--border)] bg-[var(--card)] p-2 text-[var(--foreground)] shadow-[var(--shadow-card)] transition-colors hover:bg-[var(--secondary)] md:hidden"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Outlet />
      </main>
    </div>
  );
}
