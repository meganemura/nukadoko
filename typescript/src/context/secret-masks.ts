import type { Locator, Page } from "playwright";
import { MIN_REDACTABLE_LENGTH, type SecretSet } from "../secrets/types.js";

// Responsibility: name the parts of a page that show a loaded secret, so a
// screenshot nukadoko takes covers them (Playwright's `mask`). The text
// redaction in secrets/redact.ts cannot reach pixels. Boundary: it only
// reads the page. Marking the elements with an attribute, or rewriting
// their text, would change the page the next step reads, so each part is a
// locator: the text that holds a secret, and the fields whose value does.
//
// Honest limits: only the loaded value as written is found, not an encoded
// spelling of it; a secret split across elements, drawn on a canvas, or
// shown in an image is not; `getByText` ignores case, so a part that only
// resembles a secret can be covered too, which costs pixels, never a leak.

/** Locators for every element of `page`, in every frame, that shows one
 * of `secrets`: as text, or as the value of an input or textarea. */
export async function secretMasks(page: Page, secrets: SecretSet): Promise<Locator[]> {
  const values = secrets.filter((entry) => entry.keep === undefined && entry.value.length >= MIN_REDACTABLE_LENGTH).map((entry) => entry.value);
  if (values.length === 0) return [];
  const masks: Locator[] = [];
  for (const frame of page.frames()) {
    for (const value of values) masks.push(frame.getByText(value));
    // A field's value is not text `getByText` reads, and a step may have
    // typed the secret into it.
    const fields = frame.locator("input, textarea");
    const held = await fields.evaluateAll((elements) => elements.map((element) => String((element as { value?: unknown }).value ?? "")));
    held.forEach((text, index) => {
      if (values.some((value) => text.includes(value))) masks.push(fields.nth(index));
    });
  }
  return masks;
}
