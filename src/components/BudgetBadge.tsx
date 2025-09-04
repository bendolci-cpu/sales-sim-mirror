"use client";

import { useEffect, useState, useRef, useCallback } from "react";

type BudgetResp = {
  usage: number;
  remaining: number;
  allowed: boolean;
  hasKey: boolean;
  budgetOk: boolean;
  max: number;
};

// Helper function to format currency with appropriate decimal places
function formatCurrency(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  if (amount < 0.1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export default function BudgetBadge() {
  const [data, setData] = useState<BudgetResp | null>(null);
  const [lastLogTime, setLastLogTime] = useState(0);
  const prevDataRef = useRef<BudgetResp | null>(null);
  
  // Check if debug logging is enabled
  const isDebugEnabled = process.env.NEXT_PUBLIC_DEBUG_BUDGET === '1';

  // Memoized fetch function to prevent recreation on every render
  const fetchBudget = useCallback(async () => {
    try {
      const res = await fetch("/api/budget");
      if (!res.ok) return;
      const json = (await res.json()) as BudgetResp;
      setData(json);
    } catch {
      // Silently handle errors to avoid console spam
    }
  }, []);

  // Debug logging that only fires when values actually change
  useEffect(() => {
    if (!isDebugEnabled || !data) return;
    
    const now = Date.now();
    const hasChanged = !prevDataRef.current || 
      prevDataRef.current.usage !== data.usage ||
      prevDataRef.current.remaining !== data.remaining ||
      prevDataRef.current.allowed !== data.allowed;
    
    // Only log if data changed and we haven't logged recently (throttle to 2 seconds)
    if (hasChanged && (now - lastLogTime > 2000)) {
      console.log('[BudgetBadge] Data updated:', {
        usage: data.usage,
        remaining: data.remaining,
        allowed: data.allowed,
        max: data.max
      });
      setLastLogTime(now);
      prevDataRef.current = data;
    }
  }, [data, isDebugEnabled, lastLogTime]);

  // Set up polling once on mount with proper cleanup
  useEffect(() => {
    let cancelled = false;
    
    // Initial fetch
    fetchBudget();

    // Set up polling for real-time updates (30 seconds as suggested)
    const interval = setInterval(() => {
      if (!cancelled) {
        fetchBudget();
      }
    }, 30000);

    // Cleanup function
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchBudget]); // Only depend on the memoized fetchBudget function

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
      <span>{formatCurrency(usage)} / {formatCurrency(max)}</span>
    </div>
  );
}


