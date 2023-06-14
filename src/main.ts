import { DataSource, Email, EmailSender, PrismaClient } from "@prisma/client";
import assert, { AssertionError } from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";

import { authenticate } from "./auth.js";
import { CURRENT_MODEL_NAME, extractFromEmail } from "./llm.js";

const LOOKBACK_DAYS = 60;

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
    const byUserAndRecent = {
      scrapedBy: auth.user,
      uid: { gte: minUid }
    };
    // ignoredUids: emails that cannot be dormspams because they don't contain the keywords.
    const ignoredUids = await prisma.ignoredEmail.findMany({
      select: { uid: true },
      where: byUserAndRecent
    });
    // processedUids: emails that have been processed by the current model.
    const processedUids = await prisma.email.findMany({
      select: { uid: true },
      where: { ...byUserAndRecent, modelName: { equals: CURRENT_MODEL_NAME } }
    });

    // seenUids: no need to look at these emails again. saves bandwidth and tokens.
    const seenUids = ignoredUids.concat(processedUids).map((email) => email.uid);
    const uids = allUids.filter((uid) => !seenUids.includes(uid));
    console.log(`Received unseen ${uids.length} mails in the past ${LOOKBACK_DAYS} days`);
    if (uids.length === 0) {
      console.log("Nothing to do...");
      return;
    }

    // We need not fetch these processed emails to save bandwidth.
    const fetchedEmails = await prisma.email.findMany({
      where: { ...byUserAndRecent, modelName: { not: CURRENT_MODEL_NAME } },
      include: { sender: true }
    });
    const fetchedUids = fetchedEmails.map((email) => email.uid);

    const mailProcessors: Promise<void>[] = [];
    for await (let message of client.fetch(
      uids.filter((uid) => !fetchedUids.includes(uid)),
      { uid: true, envelope: true, source: true },
      { uid: true, changedSince: 0n }
    )) {
      mailProcessors.push(
        simpleParser(message.source).then((parsed) =>
          processMail(prisma, auth.user, message.uid, parsed)
        )
      );
    }

    mailProcessors.push(
      ...fetchedEmails.map((email) =>
        processMail(prisma, auth.user, email.uid, emailToRelaxedParsedMail(email))
      )
    );

    await Promise.all(mailProcessors);
  } finally {
    lock.release();
    await prisma.$disconnect();
    await client.logout();
  }
}

type RelaxedParsedMail = Omit<ParsedMail, "attachments" | "headers" | "headerLines" | "from"> & {
  from?: Omit<AddressObject, "html" | "text"> | undefined;
};

function isDormspam(parsed: RelaxedParsedMail): boolean {
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

function emailToRelaxedParsedMail(email: Email & { sender: EmailSender }): RelaxedParsedMail {
  return {
    messageId: email.messageId,
    from: {
      value: [
        {
          address: email.sender.email,
          name: email.sender.name ?? email.sender.email
        }
      ]
    },
    html: email.body,
    subject: email.subject,
    date: email.receivedAt,
    inReplyTo: email.inReplyToId ?? undefined,
    text: convert(email.body)
  };
}

async function processMail(
  prisma: PrismaClient,
  scrapedBy: string,
  uid: number,
  parsed: RelaxedParsedMail
): Promise<void> {
  const receivedAt = parsed.date ?? new Date();
  let email: Email | undefined = undefined;

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
    email = await prisma.email.upsert({
      where: { messageId },
      create: {
        messageId,
        scrapedBy,
        uid,
        sender: {
          connectOrCreate: {
            where: { email: senderAddress },
            create: { email: senderAddress, name: senderName }
          }
        },
        subject,
        body: html,
        receivedAt,
        modelName: CURRENT_MODEL_NAME,
        inReplyTo
      },
      update: { modelName: CURRENT_MODEL_NAME }
    });

    const text = parsed.text ?? convert(html);
    const extractedEvent = await extractFromEmail(subject, text, receivedAt);
    if (!extractedEvent.event) return;

    let root = email;
    while (root.inReplyToId !== null) {
      root =
        (await prisma.email.findUnique({ where: { messageId: root.inReplyToId } })) ??
        assert.fail("Thread root not in database");
    }

    const existing = await prisma.event.findFirst({ where: { fromEmailId: root.messageId } });
    if (existing !== null) return;

    const dates =
      extractedEvent.dateTime instanceof Date ? [extractedEvent.dateTime] : extractedEvent.dateTime;

    await Promise.all(
      dates.map((date) =>
        prisma.event.create({
          data: {
            date,
            source: DataSource.DORMSPAM,
            title: extractedEvent.title,
            location: extractedEvent.location,
            organizer: extractedEvent.organizer,
            fromEmail: { connect: { messageId: root.messageId } }
          }
        })
      )
    );

    console.log(`Registered email: ${parsed.subject}: `, extractedEvent);
  } catch (error) {
    if (error instanceof AssertionError || error instanceof RangeError) {
      console.log(`Ignored email: ${parsed.subject} ${uid}`);
      await prisma.ignoredEmail.upsert({
        where: { scrapedBy_uid: { scrapedBy, uid } },
        create: { scrapedBy, uid, receivedAt },
        update: {}
      });
    } else {
      if (email !== undefined) {
        await prisma.email.update({
          where: { messageId: email.messageId },
          data: { modelName: "" }
        });
      }
      throw error;
    }
  }
}

await main();
