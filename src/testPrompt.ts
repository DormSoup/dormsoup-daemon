import assert from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import readline from "readline/promises";

import { authenticate } from "./auth.js";
import { extractFromEmail } from "./llm.js";

async function main(): Promise<void> {
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
        const text = parsed.text ?? convert(parsed.html);
        const event = await extractFromEmail(
            parsed.subject ?? "No subject",
            text,
            parsed.date ?? new Date(),
            true
        );
        console.log("Extracted event:", event);
    } finally {
        lock.release();
        await client.logout();
        process.exit(0);
    }
}

await main();
