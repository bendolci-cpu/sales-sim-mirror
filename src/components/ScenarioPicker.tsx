"use client";

import { useMemo, useState } from "react";
import { SCENARIOS } from "@/data/scenarios";

type ScenarioPickerProps = {
  value?: string;
  onChange: (id: string) => void;
  size?: "lg" | "sm";
};

export default function ScenarioPicker({ value, onChange, size = "sm" }: ScenarioPickerProps) {
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || size !== "lg") return SCENARIOS;
    return SCENARIOS.filter(s =>
      [s.id, s.title, s.persona, s.setting, s.summary, s.callPoint, s.topic]
        .some(field => field.toLowerCase().includes(q))
    );
  }, [query, size]);

  const selected = useMemo(() => SCENARIOS.find(s => s.id === value), [value]);

  // Debug: trace picker state
  // eslint-disable-next-line no-console
  console.log("[ScenarioPicker]", { size, value, query });

  return (
    <div className={size === "lg" ? "w-full" : "w-full max-w-xs"}>
      {size === "lg" && (
        <input
          aria-label="Search scenarios"
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by title, persona, or setting..."
          className="mb-2 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      )}

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
            {s.title}
          </option>
        ))}
      </select>

      {size === "lg" && selected && (
        <div className="mt-2 text-sm">
          <div className="text-gray-900 leading-5">{selected.title}</div>
          <div className="text-gray-500 text-xs">Call Point: {selected.callPoint} • Topic: {selected.topic}</div>
          <p className="mt-1 text-gray-700">{selected.brief}</p>
        </div>
      )}
    </div>
  );
}


