import React from "react";

type Props = {
  label: string;
  value: string | number;
  sublabel?: string;
};

export default function MetricCard({ label, value, sublabel }: Props) {
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sublabel ? <div className="mt-1 text-xs text-gray-400">{sublabel}</div> : null}
    </div>
  );
}


