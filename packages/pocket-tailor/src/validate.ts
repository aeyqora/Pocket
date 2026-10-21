import type { TailoringDefinition, TailoringMeta } from "./types.js";

/**
 * Enforce the contract every tailored rule must meet: it documents itself and
 * it changes presentation. Checked at definition time so a missing URL or a
 * no-op rule fails when the module loads, not when someone finally lints.
 */
export function assertTailoringDefinition(definition: TailoringDefinition): void {
  const label = describe(definition);
  const candidate = definition as Partial<TailoringDefinition>;
  const meta = candidate.meta as Partial<TailoringMeta> | undefined;

  if (!meta || typeof meta !== "object") {
    throw new Error(`pocket-tailor: ${label} must declare meta.`);
  }

  const docs = meta.docs;
  if (!docs || typeof docs !== "object") {
    throw new Error(
      `pocket-tailor: ${label} must declare meta.docs with a description and an absolute http(s) url.`,
    );
  }

  if (typeof docs.description !== "string" || docs.description.trim() === "") {
    throw new Error(
      `pocket-tailor: ${label} must declare a non-empty meta.docs.description.`,
    );
  }

  if (typeof docs.url !== "string" || !isHttpUrl(docs.url)) {
    throw new Error(
      `pocket-tailor: ${label} must declare an absolute http(s) meta.docs.url; ` +
        `got ${JSON.stringify(docs.url)}.`,
    );
  }

  if (candidate.message !== undefined && (typeof candidate.message !== "string" || candidate.message.trim() === "")) {
    throw new Error(`pocket-tailor: ${label} must declare a non-empty message.`);
  }

  const messages = meta.messages;
  if (messages !== undefined && (typeof messages !== "object" || messages === null || Array.isArray(messages))) {
    throw new Error(`pocket-tailor: ${label} must declare meta.messages as an object.`);
  }

  if (messages) {
    for (const [id, message] of Object.entries(messages)) {
      if (typeof message !== "string" || message.trim() === "") {
        throw new Error(
          `pocket-tailor: ${label} declares an empty message for ${JSON.stringify(id)}.`,
        );
      }
    }
  }

  if (candidate.report !== undefined && typeof candidate.report !== "function") {
    throw new Error(`pocket-tailor: ${label} must declare report as a function.`);
  }

  const hasMessages = messages !== undefined && Object.keys(messages).length > 0;
  if (!hasMessages && typeof candidate.message !== "string" && typeof candidate.report !== "function") {
    throw new Error(
      `pocket-tailor: ${label} must tailor presentation: ` +
        `declare message, at least one meta.messages entry, or a report() hook.`,
    );
  }
}

function describe(definition: TailoringDefinition): string {
  const tailors = definition?.tailors;
  if (typeof tailors === "string" && tailors.trim() !== "") {
    return `tailored rule '${tailors}'`;
  }
  return "direct-module tailored rule";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
