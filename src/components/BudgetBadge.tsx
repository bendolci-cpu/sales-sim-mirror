"use client";

import { useEffect, useState } from "react";

type BudgetResp = {
  usage: number;
  remaining: number;
  allowed: boolean;
  hasKey: boolean;
  budgetOk: boolean;
  max: number;
};

export default function BudgetBadge() {
  const [data, setData] = useState<BudgetResp | null>(null);

  useEffect(() => {
    let cancelled = false;
    
    const fetchBudget = async () => {
      try {
        const res = await fetch("/api/budget");
        if (!res.ok) return;
        const json = (await res.json()) as BudgetResp;
        if (!cancelled) setData(json);
      } catch {}
    };

    // Initial fetch
    fetchBudget();

    // Set up polling for real-time updates
    const interval = setInterval(fetchBudget, 5000); // Update every 5 seconds

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const usage = data?.usage ?? 0;
  const max = data?.max ?? 0;
  const allowed = data?.allowed ?? true;

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${
        allowed ? "border-gray-200 text-gray-700 bg-white" : "border-red-200 text-red-700 bg-red-50"
      }`}
      title={allowed ? "Budget status" : "Budget cap reached"}
    >
      <span className="font-medium">Budget:</span>
      <span>${usage.toFixed(2)} / ${max.toFixed(2)}</span>
    </div>
  );
}


