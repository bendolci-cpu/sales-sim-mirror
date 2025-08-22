export type CallTurn = {
  id: string;
  at: number; // ms offset from call start
  speaker: "user" | "agent";
  text: string;
  charCount: number;
  wpm?: number;
  interrupted?: boolean;
};

export type CallMeta = {
  id: string;
  startedAt: number;
  endedAt?: number;
  scenarioId: string;
  durationMs?: number;
  turns: CallTurn[];
  stats?: { userWpmAvg?: number; interruptions?: number; agentTurns?: number; userTurns?: number };
};


