import { ImapFlow } from "imapflow";
import assert from "assert";
import dotenv from "dotenv";

dotenv.config();

const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    auth: {
        user: process.env.MAIL_USER!!,
        pass: process.env.MAIL_PASS
    }
});

console.log(process.env.MAIL_USER!!);

export default async function main() {
    // Wait until client connects and authorizes
    await client.connect();

    // Select and lock a mailbox. Throws if mailbox does not exist
    let lock = await client.getMailboxLock("INBOX");
    try {
        // fetch latest message source
        // client.mailbox includes information about currently selected mailbox
        // "exists" value is also the largest sequence number available in the mailbox
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        let message = await client.fetchOne(`${client.mailbox.exists}`, { source: true });
        console.log(message.source.toString());

        // list subjects for all messages
        // uid value is always included in FETCH response, envelope strings are in unicode.
        for await (let message of client.fetch("1:*", { envelope: true })) {
            console.log(`${message.uid}: ${message.envelope.subject}`);
        }
    } finally {
        // Make sure lock is released, otherwise next `getMailboxLock()` never returns
        lock.release();
    }

    // log out and close connection
    await client.logout();
}

main();
