import assert from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import readline from "readline/promises";

import { authenticate } from "../auth.js";
import { extractFromEmail } from "../llm/emailToEvents.js";

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

function isDormspam(parsed: any): boolean {
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
  return dormspamKeywords.some((keyword) => parsed.text?.includes(keyword));
}

async function main(): Promise<void> {
    // process.env.DEBUG_MODE = "true";
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
        const parsed = await simpleParser(message.source, {
            skipImageLinks: true,
            skipHtmlToText: false
        });
        assert(parsed.html);
        console.log(parsed.text);
        console.log(isDormspam(parsed));
        const text = parsed.text ?? convert(parsed.html);
        const event = await extractFromEmail(
            parsed.subject ?? "No subject",
            text,
            parsed.date ?? new Date(),
        );
        console.log("Extracted event:", event);
    } finally {
        lock.release();
        await client.logout();
        process.exit(0);
    }
}

await main();
