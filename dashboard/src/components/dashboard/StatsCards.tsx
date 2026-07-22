import { Users, Activity, CheckCircle, Zap } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

interface StatsData {
  accounts: { active: number; total: number };
  requests: number;
  successRate: number;
  totalTokens: number;
}

interface StatsCardsProps {
  data?: StatsData;
}

const defaultData: StatsData = {
  accounts: { active: 0, total: 0 },
  requests: 0,
  successRate: 0,
  totalTokens: 0,
};

export default function StatsCards({ data = defaultData }: StatsCardsProps) {
  const stats = [
    {
      label: "Accounts",
      value: `${data.accounts.active}/${data.accounts.total}`,
      subtitle: "active",
      icon: <Users className="h-4 w-4" />,
      emphasize: false,
    },
    {
      label: "Requests",
      value: data.requests.toLocaleString(),
      subtitle: "All time",
      icon: <Activity className="h-4 w-4" />,
      emphasize: false,
    },
    {
      label: "Success Rate",
      value: `${data.successRate}%`,
      subtitle: "All time",
      icon: <CheckCircle className="h-4 w-4" />,
      emphasize: true,
    },
    {
      label: "Total Tokens",
      value: formatTokens(data.totalTokens),
      subtitle: "All time",
      icon: <Zap className="h-4 w-4" />,
      emphasize: false,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <StatCard
          key={stat.label}
          label={stat.label}
          value={stat.value}
          subtitle={stat.subtitle}
          icon={stat.icon}
          emphasize={stat.emphasize}
          className="transition-all hover:border-[var(--primary)]/40"
        />
      ))}
    </div>
  );
}
