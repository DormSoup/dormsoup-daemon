import assert from "assert";
import { convert } from "html-to-text";
import { simpleParser } from "mailparser";
import readline from "readline/promises";
import { promises as fs } from "fs";
import glob from "glob-promise";

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

async function main(): Promise<void> {
  process.env.DEBUG_MODE = "true";
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  try {
    const subject = await readlineInterface.question("Email subject: ");
    const emailsPath = await readlineInterface.question("Path to *.eml: ");
    const emlFiles = await glob(`${emailsPath}/*.eml`);

    const matchedEmails = [];

    for (const emlFile of emlFiles) {
      const emlContent = await fs.readFile(emlFile, `utf8`);
      const parsed = await simpleParser(emlContent, {
        skipImageLinks: true,
        skipHtmlToText: false
      });
      if (parsed.subject === subject) {
        matchedEmails.push(parsed);
      }
    }

    if (matchedEmails.length === 0) {
      console.error("No emails found");
      return;
    }

    // fetch one most recent email matching the subject
    matchedEmails.sort((a, b) => {
      const dateA = a.date ? a.date.getTime() : 0;
      const dateB = b.date ? b.date.getTime() : 0;
      return dateB - dateA;
    });
    const parsed = matchedEmails[0];
    assert(parsed.html || parsed.text);

    const text = parsed.text ?? convert(parsed.html!);
    console.log(text);
    const event = await extractFromEmail(
      parsed.subject ?? "No subject",
      text,
      parsed.date ?? new Date()
    );
    console.log("Extracted event:", event);
  } finally {
    readlineInterface.close();
  }
}

await main();
