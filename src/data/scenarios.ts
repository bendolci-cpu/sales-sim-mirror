export type Scenario = {
  id: string;
  title: string;
  role: string;
  industry: string;
  description: string;
  starter: string;
  objectives: string[];
  hints: string[];
};

export const scenarios: Scenario[] = [
  {
    id: "saas-renewal",
    title: "Enterprise SaaS Renewal Negotiation",
    role: "Account Executive",
    industry: "SaaS / B2B",
    description:
      "Customer's annual contract is up for renewal. They had under-utilization in two regions and are asking for a discount. You must defend value, explore usage blockers, and land a fair multi-year renewal.",
    starter:
      "We're considering not renewing the full package. Our usage dropped in EMEA and LATAM, so this pricing doesn't make sense anymore.",
    objectives: [
      "Diagnose root cause of under-utilization",
      "Position value relative to outcomes, not just seats",
      "Propose options (tiering or phased ramp) to address usage concerns",
      "Close a win-win renewal (ideally multi-year)",
    ],
    hints: [
      "Ask about specific teams and workflows affected",
      "Quantify value realized in other regions",
      "Introduce pilot expansion with success criteria",
      "Offer terms that protect value (multi-year, ramp, or training add-on)",
    ],
  },
  {
    id: "security-poc",
    title: "Security Tooling Proof-of-Concept",
    role: "Sales Engineer",
    industry: "Cybersecurity",
    description:
      "Prospect needs to validate detection coverage with limited lab time. They will compare you to two competitors on ease-of-deployment and signal fidelity.",
    starter:
      "We only have two weeks to evaluate. If setup takes more than a day, we'll move on.",
    objectives: [
      "Clarify evaluation criteria and success metrics",
      "Remove setup friction with a guided plan",
      "Showcase 2-3 differentiated detections",
      "Align sign-off process and next steps",
    ],
    hints: [
      "Confirm which environments are in-scope",
      "Provide a step-by-step day 1 plan",
      "Use real customer stories to de-risk",
      "Schedule midpoint and final readouts",
    ],
  },
  {
    id: "manufacturing-crm",
    title: "CRM Rollout for Multi-Plant Manufacturer",
    role: "Implementation Consultant",
    industry: "Manufacturing",
    description:
      "Operations wants a phased CRM rollout across three plants with unionized labor. Stakeholders are risk-averse and need clear change management.",
    starter:
      "We've tried CRM twice. Adoption failed on the floor. What's different this time?",
    objectives: [
      "Map stakeholders across plants and shifts",
      "Co-design a pilot with frontline champions",
      "Define adoption metrics and training plan",
      "Set a realistic rollout timeline and governance",
    ],
    hints: [
      "Ask about prior rollout pitfalls",
      "Involve supervisors early",
      "Show quick wins tied to safety/throughput",
      "Propose a weekly steering cadence",
    ],
  },
  {
    id: "finserv-compliance",
    title: "FinServ Compliance Automation",
    role: "Account Manager",
    industry: "Financial Services",
    description:
      "Bank needs to automate parts of quarterly compliance reporting. Legal is concerned about audit trails; Ops needs low-touch workflows.",
    starter:
      "Audit wants absolute traceability. If your system can't provide that, we can't move forward.",
    objectives: [
      "Uncover must-have compliance requirements",
      "Map workflows and handoffs across teams",
      "Demonstrate audit logging and approvals",
      "Outline a low-risk pilot scoped to one report",
    ],
    hints: [
      "Mirror their control language",
      "Bring a sample report walkthrough",
      "Offer an auditor-facing demo mode",
      "Clarify data retention and access controls",
    ],
  },
];


