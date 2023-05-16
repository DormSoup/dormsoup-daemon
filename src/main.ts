import { DataSource, PrismaClient } from "@prisma/client";
import assert, { AssertionError } from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { ParsedMail, simpleParser } from "mailparser";

import { authenticate } from "./auth.js";
import { CURRENT_MODEL_NAME, extractFromEmail } from "./llm.js";

const LOOKBACK_DAYS = 7;

export default async function main() {
    const auth = await authenticate();
    const client = new ImapFlow({
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        auth,
        logger: false
    });

    const prisma = new PrismaClient();
    await client.connect();

    let lock = await client.getMailboxLock("INBOX");
    try {
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        const since = new Date();
        since.setDate(new Date().getDate() - LOOKBACK_DAYS);
        const allUids = await client.search({ since: since }, { uid: true });
        // minUid: what is the earliest email received after `since`? 
        const minUid = Math.min(...allUids);
        // ignoredUids: emails that cannot be dormspams because they don't contain the keywords.
        const ignoredUids = await prisma.ignoredEmail.findMany({
            select: { uid: true },
            where: {
                scrapedBy: auth.user,
                uid: { gte: minUid }
            }
        });
        // processedUids: emails that have been processed by the current model.
        const processedUids = await prisma.email.findMany({
            select: { uid: true },
            where: {
                scrapedBy: auth.user,
                uid: { gte: minUid },
                modelName: { equals: CURRENT_MODEL_NAME }
            }
        });
        // seenUids: no need to look at these emails again. saves bandwidth and tokens.
        const seenUids = ignoredUids.concat(processedUids).map((email) => email.uid);
        const uids = allUids.filter((uid) => !seenUids.includes(uid));
        console.log(`Received unseen ${uids.length} mails in the past ${LOOKBACK_DAYS} days`);
        if (uids.length === 0) {
            console.log("Nothing to do...");
            return;
        }
        for await (let message of client.fetch(
            uids,
            {
                uid: true,
                envelope: true,
                source: true
            },
            { uid: true, changedSince: 0n }
        )) {
            const parsed = await simpleParser(message.source, { skipImageLinks: true });
            await processMail(prisma, auth.user, message.uid, parsed);
        }
    } finally {
        lock.release();
        await prisma.$disconnect();
        await client.logout();
    }
}

function isDormspam(parsed: ParsedMail): boolean {
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

async function processMail(
    prisma: PrismaClient,
    scrapedBy: string,
    uid: number,
    parsed: ParsedMail
): Promise<void> {
    const receivedAt = parsed.date ?? new Date();
    try {
        assert(isDormspam(parsed));
        const { messageId, from, html, subject } = parsed;
        assert(messageId !== undefined && from !== undefined && html && subject !== undefined);
        const sender = from.value[0];
        assert(sender.address !== undefined);
        const senderAddress = sender.address;
        const senderName = sender.name ?? senderAddress;

        let inReplyTo = undefined;
        if (parsed.inReplyTo !== undefined) {
            const inReplyToEmail = await prisma.email.findUnique({
                where: { messageId: parsed.inReplyTo }
            });
            assert(inReplyToEmail !== null);
            inReplyTo = {
                connect: { messageId: parsed.inReplyTo }
            };
        }
        const email = await prisma.email.upsert({
            where: { messageId },
            create: {
                messageId,
                scrapedBy,
                uid,
                sender: {
                    connectOrCreate: {
                        where: { email: senderAddress },
                        create: {
                            email: senderAddress,
                            name: senderName
                        }
                    }
                },
                subject,
                body: html,
                receivedAt,
                modelName: CURRENT_MODEL_NAME,
                inReplyTo
            },
            update: {
                modelName: CURRENT_MODEL_NAME
            }
        });

        const text = parsed.text ?? convert(html);
        const extractedEvent = await extractFromEmail(subject, text, receivedAt);
        if (!extractedEvent.event) return;
        // LLM may return malformed datetime.
        void extractedEvent.dateTime.toISOString();

        let root = email;
        while (root.inReplyToId !== null) {
            root =
                (await prisma.email.findUnique({ where: { messageId: root.inReplyToId } })) ??
                assert.fail("Thread root not in database");
        }

        await prisma.event.upsert({
            where: { fromEmailId: root.messageId },
            create: {
                source: DataSource.DORMSPAM,
                title: extractedEvent.title,
                date: extractedEvent.dateTime,
                location: extractedEvent.location,
                organizer: extractedEvent.organizer,
                fromEmail: {
                    connect: {
                        messageId: root.messageId
                    }
                }
            },
            update: {
                title: extractedEvent.title,
                date: extractedEvent.dateTime,
                location: extractedEvent.location,
                organizer: extractedEvent.organizer
            }
        });
        console.log(`Registered email: ${parsed.subject}: `, extractedEvent);
    } catch (error) {
        if (error instanceof AssertionError || error instanceof RangeError) {
            console.log(`Ignored email: ${parsed.subject} ${uid}`);
            await prisma.ignoredEmail.upsert({
                where: { scrapedBy_uid: { scrapedBy, uid } },
                create: {
                    scrapedBy,
                    uid,
                    receivedAt
                },
                update: {}
            });
        } else {
            throw error;
        }
    }
}

await main();
