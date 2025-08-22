"use client";

import { useMemo } from "react";
import { SCENARIOS, type Scenario } from "@/data/scenarios";

type ScenarioPickerProps = {
  value?: string;
  onChange: (id: string) => void;
  size?: "lg" | "sm";
};

export default function ScenarioPicker({ value, onChange, size = "sm" }: ScenarioPickerProps) {
  const options: Scenario[] = useMemo(() => SCENARIOS, []);

  return (
    <div className={size === "lg" ? "w-full" : "w-full max-w-xs"}>
      <select
        aria-label="Select a scenario"
        className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
        value={value || ""}
        onChange={e => onChange(e.target.value)}
      >
        <option value="" disabled>
          -- Pick a scenario --
        </option>
        {options.map(s => (
          <option key={s.id} value={s.id}>
            {s.topic} • {s.callPoint}
          </option>
        ))}
      </select>
    </div>
  );
}


