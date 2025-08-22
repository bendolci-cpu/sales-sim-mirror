"use client";

import { useEffect, useState } from "react";

type Props = {
  className?: string;
  onChange?: (show: boolean) => void;
};

export default function DebugToggle({ className, onChange }: Props) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem("showChatDebug") : null;
      if (raw === "1") setShow(true);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        localStorage.setItem("showChatDebug", show ? "1" : "0");
      }
    } catch {}
    onChange?.(show);
  }, [show, onChange]);

  return (
    <button
      type="button"
      aria-pressed={show}
      onClick={() => setShow(v => !v)}
      className={`select-none rounded-full border px-3 py-1 text-xs text-gray-600 hover:bg-gray-100 active:opacity-90 dark:text-gray-300 dark:hover:bg-gray-800 ${className ?? ""}`}
      title="Show/Hide text chat for debugging"
      aria-label="Toggle Chat (Debug)"
    >
      {show ? "Hide Chat (Debug)" : "Show Chat (Debug)"}
    </button>
  );
}


