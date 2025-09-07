export function isFragment(hypo: string): boolean {
  const text = (hypo || '').trim();
  if (!text) return true;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return true;
  const tail = /(and|or|but|so|because|if|when|while|that|which|who|what|how|why|wanted to|trying to|going to|I mean|you know|hold on|one sec|wait|let me)\s*$/i;
  if (tail.test(text)) return true;
  const hasTerminal = /[.!?]$/.test(text);
  if (!hasTerminal && words.length <= 6) return true;
  return false;
}

export function endsWithHoldPhrase(hypo: string): boolean {
  const text = (hypo || '').trim();
  return /\b(hold on|one sec(ond)?|wait|give me (a )?sec(ond)?)\b/i.test(text);
}


