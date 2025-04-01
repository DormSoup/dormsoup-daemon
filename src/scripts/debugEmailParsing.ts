import assert from "assert";
import { convert } from "html-to-text";
import { Source, simpleParser } from "mailparser";

import { isDormspam } from "../emailToEvents.js";
import { Event, ExtractFromEmailResult, extractFromEmail } from "../llm/emailToEvents";

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
  
  // Get text content from either the text field or by converting HTML if available
  let text: string;
  if (parsed.text) {
    text = parsed.text;
  } else if (parsed.html) {
    text = convert(parsed.html);
  } else {
    // If neither text nor HTML is available, use an empty string
    text = "";
    console.warn("Warning: Email has neither text nor HTML content");
  }

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
