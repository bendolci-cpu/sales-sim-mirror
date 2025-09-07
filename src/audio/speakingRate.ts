export function calcWpm(words: number, ms: number): number {
  if (ms <= 0) return 0;
  return (words / (ms / 60000));
}

export function adaptTimeouts(wpm: number): { overallSilenceMs: number; continueWindowMs: number; requiredSilenceMsShort: number; requiredSilenceMsLong: number } {
  if (wpm < 110) {
    return { overallSilenceMs: 4800, continueWindowMs: 1400, requiredSilenceMsShort: 750, requiredSilenceMsLong: 450 };
  }
  if (wpm < 140) {
    return { overallSilenceMs: 4200, continueWindowMs: 1200, requiredSilenceMsShort: 700, requiredSilenceMsLong: 400 };
  }
  return { overallSilenceMs: 3400, continueWindowMs: 800, requiredSilenceMsShort: 600, requiredSilenceMsLong: 350 };
}


