import assert from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { simpleParser, Source } from "mailparser";
import readline from "readline/promises";

import { authenticate } from "../auth.js";
import { extractFromEmail, Event, ExtractFromEmailResult, NonEmptyArray } from "../llm/emailToEvents.js";

// Good test cases
// Event with multiple times (same location): Ascension
// Multiple events with different times & locations: Pride Month Events
// Event with a speaker that might be mistaken as organizer: UN x MIT
// Not event: Senior Sale
// Long event: DormSoup Newsletter Test
// Hiring actors for future event: Seeking Directorial and Production Staff for THE FANTASTICKS
// Volunteering Oppurtunity: Teach CS to Under-resourced High Schoolers
// Selling tickets: 100 gecs
// Looking for tickets: Looking for ADT Thursday5/18 9-11pm Tickets

function isDormspam(text: string): boolean {
  // See https://how-to-dormspam.mit.edu/.
  const dormspamKeywords = [
    "bcc'd to all dorms",
    "bcc's to all dorms",
    "bcc'd to dorms",
    "bcc'ed dorms",
    "bcc'ed to dorms",
    "bcc to dorms",
    "bcc'd to everyone",
    "bcc dormlists",
    "bcc to dormlists",
    "for bc-talk"
  ];
  return dormspamKeywords.some((keyword) => text.includes(keyword));
}

/**
 * Print some debugging information (whether the message was parsed as dormspam),
 * then parse the email to extract the events and print this.
 * 
 * @param message The raw email content, as a Buffer or string.
 * @returns A list of events
 */
async function debugEmailToEvents(messageSource: Source): Promise<NonEmptyArray<Event>> {
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
    assert(false, "The event was not successfully extracted");
  }
}

async function main(): Promise<void> {
  process.env.DEBUG_MODE = "true";
  const auth = await authenticate();
  const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    auth,
    logger: false
  });

  await client.connect();
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let lock = await client.getMailboxLock("INBOX");
  try {
    assert(typeof client.mailbox !== "boolean");
    const subject = await readlineInterface.question("Email subject: ");
    const uids = await client.search({ subject }, { uid: true });
    if (!uids) {
      console.error("No emails found");
      return;
    }
    const message = await client.fetchOne(
      Math.max(...uids).toString(),
      {
        uid: true,
        envelope: true,
        source: true
      },
      { uid: true }
    );
    debugEmailToEvents(message.source);
  } finally {
    lock.release();
    await client.logout();
    readlineInterface.close();
  }
}

await main();
