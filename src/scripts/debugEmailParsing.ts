import assert from "assert";
import { convert } from "html-to-text";
import { Source, simpleParser } from "mailparser";

import { isDormspam } from "../emailToEvents.js";
import { Event, ExtractFromEmailResult, extractFromEmail } from "../llm/emailToEvents.js";

/**
 * Print some debugging information (whether the message was parsed as dormspam),
 * then parse the email to extract the events and print this.
 *
 * @param message The raw email content, as a Buffer or string.
 * @returns A list of events
 */
export async function debugEmailToEvents(messageSource: Source): Promise<Event[]> {
  const parsed = await simpleParser(messageSource, {
    skipImageLinks: true,
    skipHtmlToText: false
  });
  assert(parsed.html);

  const text = parsed.text ?? convert(parsed.html);
  console.log(text);
  console.log("Is this a dormspam email?", isDormspam(text));
  const result: ExtractFromEmailResult = await extractFromEmail(
    parsed.subject ?? "No subject",
    text,
    parsed.date ?? new Date()
  );
  console.log("Extracted event:", result);
  if (result.status === "admitted") {
    const events = result.events;
    return events;
  } else {
    console.warn("The event was not successfully extracted");
    return [];
  }
}
