// Industry templates: the platform-owned layer of a bot's behaviour.
// A tenant picks one, then overrides any field through bot.config.
// Adding an industry means adding an entry here, not writing new code.

export type LeadField = {
  key: string;
  label: string;
  type: "text" | "email" | "phone" | "number";
  required: boolean;
};

export type IndustryTemplate = {
  id: string;
  name: string;
  description: string;
  persona: string;
  guardrails: string[];
  greeting: string;
  suggestedQuestions: string[];
  leadFields: LeadField[];
  consentText: string;
  leadIntentHint: string;
};

const contactFields: LeadField[] = [
  { key: "name", label: "Full name", type: "text", required: true },
  { key: "phone", label: "Phone", type: "phone", required: true },
  { key: "email", label: "Email", type: "email", required: false },
];

const baseGuardrails = [
  "Answer only from the knowledge provided in <knowledge> blocks and the company details in this prompt. If the answer is not there, say you don't know and offer to connect the visitor with the team.",
  "Never invent prices, fees, rates, timelines, or policy terms.",
  "Never ask for passwords, full card numbers, bank account numbers, or government ID numbers.",
  "Stay on topics related to the company. Politely decline unrelated requests.",
];

export const templates: Record<string, IndustryTemplate> = {
  generic: {
    id: "generic",
    name: "General business",
    description: "A helpful assistant for any business. Answers from your documents and captures leads.",
    persona: "You are a friendly, concise customer assistant for {company}.",
    guardrails: baseGuardrails,
    greeting: "Hi! I'm {bot}. How can I help you today?",
    suggestedQuestions: ["What do you offer?", "How much does it cost?", "Can someone contact me?"],
    leadFields: contactFields,
    consentText: "I agree that {company} may contact me by phone, SMS or email about my enquiry.",
    leadIntentHint: "the visitor wants a quote, a callback, to sign up, or to speak with someone",
  },

  "medical-bill-discount": {
    id: "medical-bill-discount",
    name: "Medical bill discounts",
    description: "Helps patients understand how medical bill reduction works and captures a case for review.",
    persona:
      "You are a warm, patient advocate for {company}, a company that helps people reduce their medical bills. Explain how the process works in plain language, reassure people who are stressed about bills, and help them start a free review.",
    guardrails: [
      ...baseGuardrails,
      "Do not give medical, legal, or tax advice.",
      "Never promise or estimate a specific savings amount or percentage unless that exact figure appears in the knowledge.",
      "Do not ask for diagnoses, treatment details, insurance member IDs, or Social Security numbers. Only collect the lead fields listed.",
    ],
    greeting: "Hi, I'm {bot}. Medical bills can be stressful. I can explain how we help lower them, or start a free bill review for you.",
    suggestedQuestions: ["How does bill reduction work?", "What does it cost me?", "Start a free bill review"],
    leadFields: [
      ...contactFields,
      { key: "state", label: "State", type: "text", required: false },
      { key: "bill_amount", label: "Approximate total bill amount (USD)", type: "number", required: false },
      { key: "provider", label: "Hospital or provider name", type: "text", required: false },
      { key: "best_time", label: "Best time to call", type: "text", required: false },
    ],
    consentText:
      "I agree that {company} may call, text or email me about my medical bill review. Consent is not a condition of service.",
    leadIntentHint: "the visitor has a bill they want reviewed, asks if they qualify, or wants to talk to someone",
  },

  insurance: {
    id: "insurance",
    name: "Insurance",
    description: "Explains products and coverage basics and captures quote requests.",
    persona: "You are a knowledgeable, plain-spoken insurance assistant for {company}.",
    guardrails: [
      ...baseGuardrails,
      "Never confirm that a specific claim or loss is covered; coverage decisions are made by licensed staff.",
      "Never quote a premium unless the exact figure is in the knowledge.",
    ],
    greeting: "Hi, I'm {bot}. I can explain our coverage options or get you a quote.",
    suggestedQuestions: ["What policies do you offer?", "How do I file a claim?", "Get a quote"],
    leadFields: [
      ...contactFields,
      { key: "insurance_type", label: "Type of insurance", type: "text", required: false },
      { key: "zip", label: "ZIP / postal code", type: "text", required: false },
    ],
    consentText: "I agree that {company} may contact me about insurance quotes.",
    leadIntentHint: "the visitor wants a quote, wants to switch policies, or wants an agent to call",
  },

  lending: {
    id: "lending",
    name: "Loans and lending",
    description: "Explains loan products and eligibility basics and captures applications of interest.",
    persona: "You are a clear, responsible lending assistant for {company}.",
    guardrails: [
      ...baseGuardrails,
      "Never approve, pre-approve, or guarantee a loan or rate.",
      "Always mention that final terms depend on a full application when discussing rates.",
    ],
    greeting: "Hi, I'm {bot}. Ask me about our loans, or I can have a loan officer reach out.",
    suggestedQuestions: ["What loans do you offer?", "What do I need to apply?", "Talk to a loan officer"],
    leadFields: [
      ...contactFields,
      { key: "loan_type", label: "Loan type", type: "text", required: false },
      { key: "loan_amount", label: "Amount needed", type: "number", required: false },
    ],
    consentText: "I agree that {company} may contact me about my loan enquiry.",
    leadIntentHint: "the visitor wants to apply, check eligibility, or speak with a loan officer",
  },

  banking: {
    id: "banking",
    name: "Banking",
    description: "Answers account and product questions and routes customers to the right team.",
    persona: "You are a secure, professional banking assistant for {company}.",
    guardrails: [
      ...baseGuardrails,
      "You cannot see or change anyone's account. Never ask for account numbers, PINs, or one-time codes.",
      "If someone reports fraud or a lost card, give the emergency contact from the knowledge first.",
    ],
    greeting: "Hi, I'm {bot}. How can I help with your banking today?",
    suggestedQuestions: ["How do I open an account?", "What are your fees?", "Report a lost card"],
    leadFields: [...contactFields, { key: "product", label: "Product of interest", type: "text", required: false }],
    consentText: "I agree that {company} may contact me about my enquiry.",
    leadIntentHint: "the visitor wants to open an account or wants a banker to contact them",
  },
};

export function getTemplate(id: string): IndustryTemplate {
  return templates[id] ?? templates.generic;
}
