import { DataSource, Email, EmailSender, PrismaClient } from "@prisma/client";
import assert from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";

import { authenticate } from "./auth.js";
import { Deferred } from "./deferred.js";
import { CURRENT_MODEL_NAME, extractFromEmail } from "./llm/emailToEvents.js";
import { removeArtifacts } from "./llm/utils.js";

export default async function fetchEmailsAndExtractEvents(lookbackDays: number = 60) {
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
    // console.log(`Mailbox has ${client.mailbox.exists} messages`);
    const since = new Date();
    since.setDate(new Date().getDate() - lookbackDays);
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
    // const seenUids = processedUids.map((email) => email.uid);
    const uids = allUids.filter((uid) => !seenUids.includes(uid));
    console.log(`Received ${uids.length} unseen mails in the past ${lookbackDays} days.`);
    if (uids.length === 0) return;

    // We need not fetch these processed emails to save bandwidth.
    const fetchedEmails = await prisma.email.findMany({
      where: { ...byUserAndRecent, modelName: { not: CURRENT_MODEL_NAME } },
      include: { sender: true },
      orderBy: { receivedAt: "asc" }
    });
    const fetchedUids = fetchedEmails.map((email) => email.uid);

    const processingTasks = new Map<string, Deferred<void>>();
    const mailProcessors: Promise<ProcessEmailResult>[] = [];

    // Have to ensure the property: For emails A & B, if A.receivedAt <= B.receivedAt, then
    // the promise processMail(..., A) must be created NO LATER THAN processMail(..., B).
    mailProcessors.push(
      ...fetchedEmails.map((email) =>
        processMail(
          prisma,
          auth.user,
          email.uid,
          emailToRelaxedParsedMail(email),
          processingTasks
        ).then((value) => {
          process.stdout.write((value as string).at(-1)!!);
          return value;
        })
      )
    );

    for await (let message of client.fetch(
      uids.filter((uid) => !fetchedUids.includes(uid)),
      { uid: true, envelope: true, source: true },
      { uid: true, changedSince: 0n }
    )) {
      mailProcessors.push(
        simpleParser(message.source)
          .then((parsed) => processMail(prisma, auth.user, message.uid, parsed, processingTasks))
          .then((value) => {
            process.stdout.write((value as string).at(-1)!!);
            return value;
          })
      );
    }

    const results = await Promise.allSettled(mailProcessors);
    const resultsByType = new Map<ProcessEmailResult, number>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        const x = resultsByType.get(result.value);
        if (x !== undefined) resultsByType.set(result.value, x + 1);
        else resultsByType.set(result.value, 1);
      }
    }
    for (const [key, value] of resultsByType) console.log(`${key}: ${value}`);
  } finally {
    lock.release();
    await prisma.$disconnect();
    await client.logout();
  }
}

type RelaxedParsedMail = Omit<ParsedMail, "attachments" | "headers" | "headerLines" | "from"> & {
  from?: Omit<AddressObject, "html" | "text"> | undefined;
};

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

const isDormspamRegex = new RegExp(
  dormspamKeywords.map((keyword) => `(${keyword.replaceAll(/ +/g, "\\s+")})`).join("|"),
  "ui"
);

function isDormspam(text: string): boolean {
  return isDormspamRegex.test(text);
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

enum ProcessEmailResult {
  MALFORMED_EMAIL = "malformed-email-M",
  NOT_DORMSPAM = "not-dormspam-D",
  DORMSPAM_BUT_ROOT_NOT_IN_DB = "dormspam-but-root-not-in-db-R",
  DORMSPAM_BUT_NOT_EVENT_BY_GPT_3 = "dormspam-but-not-event-by-gpt-3",
  DORMSPAM_BUT_NOT_EVENT_BY_GPT_4 = "dormspam-but-not-event-by-gpt-4",
  DORMSPAM_PROCESSED_WITH_SAME_PROMPT = "dormspam-processed-with-same-prompt-P",
  DORMSPAM_BUT_NETWORK_ERROR = "dormspam-but-network-error-N",
  DORMSPAM_BUT_MALFORMED_JSON = "dormspam-but-malformed-json-J",
  DORMSPAM_WITH_EVENT = "dormspam-with-event-E"
}

async function processMail(
  prisma: PrismaClient,
  scrapedBy: string,
  uid: number,
  parsed: RelaxedParsedMail,
  processingTasks: Map<string, Deferred<void>>
): Promise<ProcessEmailResult> {
  const receivedAt = parsed.date ?? new Date();

  const ignoreThisEmailForever = async () => {
    await prisma.ignoredEmail.upsert({
      where: { scrapedBy_uid: { scrapedBy, uid } },
      create: { scrapedBy, uid, receivedAt },
      update: {}
    });
  };

  const { messageId, from, html, subject } = parsed;
  // This must come before any await, so that this can be synchronously executed once the promise
  // is created.
  const deferred = new Deferred<void>();
  try {
    if (messageId !== undefined) processingTasks.set(messageId, deferred);
    console.log("Subject:", subject, "uid:", uid);

    if (
      messageId === undefined ||
      from === undefined ||
      from.value[0].address === undefined ||
      !html ||
      subject === undefined
    ) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.MALFORMED_EMAIL;
    }

    const emailWithSameMessageId = await prisma.email.findUnique({ where: { messageId } });
    if (emailWithSameMessageId !== null && emailWithSameMessageId.uid !== uid) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.MALFORMED_EMAIL;
    }

    const sender = from.value[0];
    const senderAddress = sender.address!!;
    const senderName = sender.name ?? senderAddress;

    const text = removeArtifacts(parsed.text ?? convert(html));
    if (!isDormspam(text)) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.NOT_DORMSPAM;
    }

    let inReplyTo = undefined;
    let rootMessageId = messageId;

    if (parsed.inReplyTo !== undefined) {
      const inReplyToEmail = await prisma.email.findUnique({
        where: { messageId: parsed.inReplyTo }
      });
      if (inReplyToEmail === null) return ProcessEmailResult.DORMSPAM_BUT_ROOT_NOT_IN_DB;
      let root = inReplyToEmail;
      while (root.inReplyToId !== null) {
        const nextRoot = await prisma.email.findUnique({ where: { messageId: root.inReplyToId } });
        if (nextRoot === null) return ProcessEmailResult.DORMSPAM_BUT_ROOT_NOT_IN_DB;
        root = nextRoot;
      }
      rootMessageId = root.messageId;
      inReplyTo = {
        connect: { messageId: parsed.inReplyTo }
      };

      const prevDeferred = processingTasks.get(inReplyToEmail.messageId);
      if (prevDeferred !== undefined) await prevDeferred.promise;
    }

    await prisma.email.upsert({
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
        modelName: CURRENT_MODEL_NAME + "_PROCESSING",
        inReplyTo
      },
      update: { modelName: CURRENT_MODEL_NAME + "_PROCESSING" }
    });

    const markProcessedByCurrentModel = async () => {
      await prisma.email.update({ where: { messageId }, data: { modelName: CURRENT_MODEL_NAME } });
    };

    const existing = await prisma.event.findFirst({
      where: { fromEmailId: rootMessageId },
      include: { fromEmail: { select: { modelName: true } } }
    });

    if (existing !== null) {
      // The existing email has already been processed with the current model, do nothing.
      // if (receivedAt < existing.latestUpdateTime) return;
      if (existing.fromEmail?.modelName === CURRENT_MODEL_NAME) {
        await markProcessedByCurrentModel();
        return ProcessEmailResult.DORMSPAM_PROCESSED_WITH_SAME_PROMPT;
      }
      // The existing email has been processed by an older model / prompt. Delete all associated
      // events.
      await prisma.event.deleteMany({ where: { fromEmailId: rootMessageId } });
    }

    const result = await extractFromEmail(subject, text, receivedAt);

    if (result.status === "error-malformed-json")
      return ProcessEmailResult.DORMSPAM_BUT_MALFORMED_JSON;
    if (result.status === "error-openai-network")
      return ProcessEmailResult.DORMSPAM_BUT_NETWORK_ERROR;
    if (result.status === "rejected-by-gpt-3") {
      await markProcessedByCurrentModel();
      return ProcessEmailResult.DORMSPAM_BUT_NOT_EVENT_BY_GPT_3;
    }
    if (result.status === "rejected-by-gpt-4") {
      await markProcessedByCurrentModel();
      return ProcessEmailResult.DORMSPAM_BUT_NOT_EVENT_BY_GPT_4;
    }

    await Promise.all(
      result.events.map((event) =>
        prisma.event.create({
          data: {
            date: event.dateTime,
            source: DataSource.DORMSPAM,
            title: event.title,
            location: event.location,
            organizer: event.organizer,
            duration: event.duration,
            fromEmail: { connect: { messageId: rootMessageId } },
            text
          }
        })
      )
    );

    for (const event of result.events)
      console.log(`\nRegistered email: ${parsed.subject}: `, event);
    markProcessedByCurrentModel();

    return ProcessEmailResult.DORMSPAM_WITH_EVENT;
  } finally {
    deferred.resolve();
  }
}
