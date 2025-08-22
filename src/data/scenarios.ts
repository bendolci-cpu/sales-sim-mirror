export interface Scenario {
  id: string;
  title: string;
  setting: string;
  persona: string;
  summary: string;
  callPoint: string;
  topic: string;
  brief: string;
  successCriteria: string[];
  objectionBank: string[];
  starterMessages: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "renewal-acute-care-bundle",
    title: "Acute Care Renewal • Sani-Cloth Bundle",
    setting: "Supply Chain + Infection Prevention (IDN Hospital)",
    persona: "IP Director + Value Analysis",
    summary:
      "Annual renewal discussion balancing standardization, cost per use, and compliance outcomes across ICU/ED/OR.",
    callPoint: "IP Director",
    topic: "Bundle renewal",
    brief:
      "Annual renewal for Sani‑Cloth AF3 and Bleach Wipes across ICU/ED/OR. IP wants to standardize to one SKU; Value Analysis pushes cost per use. Ensure contact time compliance, material compatibility, and training support are covered.",
    successCriteria: [
      "Re‑commit to AF3 for general use and Bleach for C. diff/terminal cleans",
      "Confirm device/material compatibility references are provided",
      "Agree on staff education plan and compliance tracking",
    ],
    objectionBank: [
      "Competitor claims lower cost per wipe",
      "Confusion about contact times across units",
      "Facilities had dwell time residue complaints",
    ],
    starterMessages: [
      "Usage is up but our budget is flat. Why not move to one cheaper wipe?",
      "We also got residue complaints on monitors—are these compatible?",
    ],
  },
  {
    id: "cdi-outbreak-icu",
    title: "ICU C. difficile Cluster • Sporicidal Protocol",
    setting: "ICU",
    persona: "ICU Nurse Manager + IP",
    summary:
      "Address elevated C. diff rates by reinforcing where/when to use sporicidal wipes and aligning the unit on workflow.",
    callPoint: "ICU Nurse Manager",
    topic: "Sporicidal protocol",
    brief:
      "Unit flagged elevated C. diff rates. You must reinforce sporicidal use (Bleach) for rooms under isolation and terminal cleans, while addressing workflow burden and odor concerns.",
    successCriteria: [
      "Confirm sporicidal use for isolation and terminal cleans",
      "Clarify frequency and who owns cleaning vs disinfection",
      "Gain buy‑in on education + audit plan (checklists/rounding)",
    ],
    objectionBank: [
      "Bleach odor complaints and staff avoidance",
      "Terminal clean delays during surge",
      "Confusion on when to use general vs sporicidal wipes",
    ],
    starterMessages: [
      "Bleach slows us down and staff hate the smell.",
      "Which rooms actually need Bleach? We’re not aligned.",
    ],
  },
  {
    id: "ed-turnover-high-touch",
    title: "ED Fast Turnover • High‑Touch Compliance",
    setting: "Emergency Department",
    persona: "ED Charge Nurse",
    summary:
      "Improve high‑touch wipe compliance under tight turnover targets using fast contact‑time products and checklists.",
    callPoint: "ED Charge Nurse",
    topic: "High‑touch compliance",
    brief:
      "ED needs sub‑5‑minute room turnovers. Ensure high‑touch objects are consistently wiped with the correct product and contact time without bottlenecks.",
    successCriteria: [
      "Agree on a high‑touch checklist (bed rails, monitor controls, keyboard, chair arms, door handles)",
      "Select fast contact‑time wipe for ED flow",
      "Plan quick‑hit training + spot audits",
    ],
    objectionBank: [
      "No time to watch a 2‑ or 3‑minute dwell",
      "Nurses think EVS will get it later",
      "Keyboard/mouse get skipped",
    ],
    starterMessages: [
      "We can’t wait for dwell times during peak hours.",
      "Our keyboards and monitors are probably getting missed.",
    ],
  },
  {
    id: "or-terminal-clean",
    title: "OR Terminal Clean • Material Compatibility",
    setting: "Operating Room",
    persona: "OR Nurse Educator + Biomed",
    summary:
      "Align AF3 vs Bleach usage and provide compatibility proof to protect devices without adding room downtime.",
    callPoint: "OR Nurse Educator",
    topic: "Material compatibility",
    brief:
      "OR is concerned about corrosion/staining on surgical tables and monitors. Validate PDI compatibility data and align on where AF3 vs Bleach is required.",
    successCriteria: [
      "Map which surfaces use AF3 vs Bleach by indication",
      "Provide manufacturer compatibility letters for monitored devices",
      "Agree on workflow that doesn’t extend room downtime",
    ],
    objectionBank: [
      "We’ve seen staining on stainless",
      "Vendor says their device needs non‑bleach only",
      "Turnover time is already tight",
    ],
    starterMessages: [
      "Biomed flagged corrosion risk—are your wipes actually approved?",
      "When do we *have* to use Bleach vs AF3?",
    ],
  },
  {
    id: "nicu-wipe-compat",
    title: "NICU Equipment • Wipe Compatibility & Residue",
    setting: "NICU",
    persona: "NICU Manager",
    summary:
      "Ensure compatible wipes and proper technique for sensitive NICU equipment while minimizing residue and odor.",
    callPoint: "NICU Manager",
    topic: "Wipe compatibility",
    brief:
      "Sensitive equipment (warmers, monitors) requires compatible wipes with minimal residue. Address compatibility references and proper technique to avoid pooling.",
    successCriteria: [
      "Provide device compatibility references for key NICU equipment",
      "Teach single‑direction wipe technique and drying",
      "Set realistic re‑wipe guidance if visibly wet",
    ],
    objectionBank: [
      "Residue on warmer screens",
      "Parents complain about smell",
      "Staff mixing glass cleaner with disinfectant",
    ],
    starterMessages: [
      "Our warmer screens streak after cleaning.",
      "Parents ask about chemical smell—what do we say?",
    ],
  },
  {
    id: "evs-audit-gap",
    title: "EVS Rounding • Audit Gap Close",
    setting: "Med‑Surg + EVS",
    persona: "EVS Manager + IP",
    summary:
      "Lift audit pass rates by standardizing a high‑touch sequence and implementing coaching with a weekly cadence.",
    callPoint: "EVS Manager",
    topic: "Audit gap close",
    brief:
      "Recent fluorescent‑marker audits showed 62% pass on high‑touch. Build a coaching plan and standardize a wipe sequence to raise compliance.",
    successCriteria: [
      "Agree on 6‑item high‑touch list and sequence",
      "Set weekly audit cadence and feedback loop",
      "Target >85% pass within 30 days",
    ],
    objectionBank: [
      "Staff turnover and float pool coverage",
      "Night shift performance lags",
      "Markers slow us down",
    ],
    starterMessages: [
      "Audit scores dipped to 62%—we need a realistic fix.",
      "Night shift misses the WOW keyboards.",
    ],
  },
];


