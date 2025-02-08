import assert from "assert";
import { ImapFlow } from "imapflow";
import readline from "readline/promises";

import { authenticate } from "../auth.js";
import { debugEmailToEvents } from "./debugEmailParsing.js";
import { debugEmailToEvents as sipbDebugEmailParsing } from "./debugSIPBLLMEmailParsing.js";

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
    sipbDebugEmailParsing(message.source);
  } finally {
    lock.release();
    await client.logout();
    readlineInterface.close();
  }
}

await main();
