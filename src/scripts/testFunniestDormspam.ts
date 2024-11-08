
import assert from "assert";
import { convert } from "html-to-text";
import { Source, simpleParser } from "mailparser";
import { isDormspam } from "../emailToEvents.js";
import { ImapFlow } from "imapflow";
import readline from "readline/promises";
import { authenticate } from "../auth.js";
import { extractJokeFromEmail, ExtractJokeFromEmailResult, Joke } from "../llm/emailToJokes.js";


export async function debugEmailToJoke(messageSource: Source): Promise<Joke | null> {
    const parsed = await simpleParser(messageSource, {
      skipImageLinks: true,
      skipHtmlToText: false
    });
    assert(parsed.html);
  
    const text = parsed.text ?? convert(parsed.html);
    console.log(text);
    console.log("Is this a dormspam email?", isDormspam(text));
    const result: ExtractJokeFromEmailResult = await extractJokeFromEmail(
      parsed.subject ?? "No subject",
      text,
      parsed.date ?? new Date()
    );
    console.log("Extracted joke:", result);
    if (result.status === "admitted") {
      return result.joke;
    } else {
      console.warn("The joke was not successfully extracted");
      return null
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
    debugEmailToJoke(message.source);
} finally {
    lock.release();
    await client.logout();
    readlineInterface.close();
}
}

await main();