import type {
  ProjectMode,
  ProjectStage,
  TechnicalRequirements,
} from "./project.ts";
import type { ExportLanguage } from "./workflow.ts";

export type EmailAttachmentReference = Readonly<{
  id: string;
  name: string;
  source:
    | "visualization"
    | "plan"
    | "summary"
    | "package"
    | "event-document"
    | "project-file";
  selected: boolean;
}>;

export type EmailTopicId =
  | "graphics"
  | "electricity"
  | "water"
  | "waste"
  | "approval"
  | "deadlines"
  | "missing-data";

export const EMAIL_TOPICS: readonly Readonly<{
  id: EmailTopicId;
  label: string;
}>[] = [
  { id: "graphics", label: "Grafika" },
  { id: "electricity", label: "Elektro" },
  { id: "water", label: "Voda" },
  { id: "waste", label: "Odpad" },
  { id: "approval", label: "Schválení návrhu" },
  { id: "deadlines", label: "Termíny" },
  { id: "missing-data", label: "Chybějící údaje" },
];

export type EmailDraft = Readonly<{
  to: string;
  cc?: string;
  subject: string;
  body: string;
  language: ExportLanguage;
  attachments: readonly EmailAttachmentReference[];
  selectedTopics: readonly EmailTopicId[];
}>;

export type EmailDraftInput = Readonly<{
  summary: string;
  language: ExportLanguage;
  purpose: string;
  attachments: readonly EmailAttachmentReference[];
  recipient?: string;
  company?: string;
  projectName?: string;
  mode?: ProjectMode;
  stage?: ProjectStage;
  requirements?: TechnicalRequirements;
  selectedTopics?: readonly EmailTopicId[];
  deadlines?: readonly string[];
}>;

export interface EmailDraftProvider {
  readonly id: string;
  create(input: EmailDraftInput): Promise<EmailDraft>;
}

export interface MailDraftProvider {
  readonly id: string;
  saveDraft(draft: EmailDraft): Promise<{ externalId: string }>;
}

export function createBasicEmailDraft(input: {
  recipient: string;
  company: string;
  projectName: string;
  language: ExportLanguage;
  attachments: readonly EmailAttachmentReference[];
}): EmailDraft {
  const english = input.language === "en";
  return {
    to: input.recipient,
    subject: english
      ? `Booth project – ${input.projectName}`
      : `Projekt stánku – ${input.projectName}`,
    body: english
      ? `Hello,\n\nplease find the prepared materials for ${input.company || input.projectName}.\n\nBest regards`
      : `Dobrý den,\n\nzasíláme připravené podklady k projektu ${input.company || input.projectName}.\n\nS pozdravem`,
    language: input.language,
    attachments: input.attachments,
    selectedTopics: [],
  };
}

export class RuleBasedEmailDraftProvider implements EmailDraftProvider {
  readonly id = "rule-based-email-draft";

  async create(input: EmailDraftInput): Promise<EmailDraft> {
    const english = input.language === "en";
    const selectedTopics = input.selectedTopics ?? [];
    const projectName = input.projectName || input.company || "projekt";
    const purpose = emailPurpose(input.mode, input.stage, english);
    const topicContent = selectedTopics.flatMap((topic) =>
      topicLines(topic, input.requirements, input.deadlines ?? [], english),
    );

    return {
      to: input.recipient ?? "",
      cc: "",
      subject: `${purpose} – ${projectName}`,
      body: [
        english ? "Hello," : "Dobrý den,",
        "",
        english
          ? `${purpose} for ${projectName}.`
          : `${purpose} k projektu ${projectName}.`,
        ...(topicContent.length
          ? ["", ...topicContent.map((line) => `• ${line}`)]
          : []),
        "",
        english ? "Best regards" : "S pozdravem",
      ].join("\n"),
      language: input.language,
      attachments: input.attachments,
      selectedTopics,
    };
  }
}

function emailPurpose(
  mode: ProjectMode | undefined,
  stage: ProjectStage | undefined,
  english: boolean,
): string {
  if (stage === "done")
    return english ? "Final project materials" : "Finální podklady projektu";
  if (stage === "approved")
    return english ? "Project confirmation" : "Potvrzení projektu";
  if (stage === "design")
    return english
      ? "Booth design for approval"
      : "Návrh stánku k odsouhlasení";
  if (mode === "order" || mode === "production")
    return english
      ? "Project implementation details"
      : "Podklady k realizaci projektu";
  return english ? "Booth proposal" : "Nabídka a návrh stánku";
}

function topicLines(
  topic: EmailTopicId,
  requirements: TechnicalRequirements | undefined,
  deadlines: readonly string[],
  english: boolean,
): readonly string[] {
  if (topic === "approval") {
    return [
      english
        ? "Please confirm the proposed booth design."
        : "Prosíme o odsouhlasení navrženého řešení stánku.",
    ];
  }
  if (topic === "deadlines") {
    return deadlines.filter(Boolean).map((value) =>
      english ? `Required deadline: ${value}.` : `Důležitý termín: ${value}.`,
    );
  }
  if (topic === "missing-data") {
    return [
      english
        ? "Please provide any missing project information."
        : "Prosíme o doplnění chybějících podkladů k projektu.",
    ];
  }

  const requirement = requirements?.[topic];
  if (!requirement || requirement.status === "unspecified") return [];
  if (requirement.status === "notWanted") return [];

  const names = english
    ? { graphics: "Artwork", electricity: "Electricity", water: "Water", waste: "Waste" }
    : { graphics: "Grafika", electricity: "Elektro", water: "Voda", waste: "Odpad" };
  const name = names[topic];
  if (requirement.status === "inquire") {
    return [
      english
        ? `Please send or confirm the requirements for ${name.toLowerCase()}.`
        : `Prosíme o zaslání nebo potvrzení požadavků: ${name}.`,
    ];
  }
  if (requirement.status === "dataReceived" || requirement.status === "ready") {
    return [english ? `${name} materials have been received.` : `${name}: podklady jsme obdrželi.`];
  }
  return [english ? `${name} is included in the project.` : `${name}: zahrnuto v projektu.`];
}

/** Future boundary; Microsoft Graph implementation belongs on the server. */
export interface OutlookDraftProvider extends MailDraftProvider {}
