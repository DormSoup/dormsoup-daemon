import { DataSource, Email, EmailSender, Event, PrismaClient } from "@prisma/client";
import assert from "assert";
import dedent from "dedent";
import filenamify from "filenamify";
import fs from "fs";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";

import { authenticate } from "./auth.js";
import { Deferred } from "./deferred.js";
import { CURRENT_MODEL_NAME, extractFromEmail } from "./llm/emailToEvents.js";
import { createEmbedding, removeArtifacts } from "./llm/utils.js";
import { sendEmail } from "./mailer.js";
import {
  acquireLock,
  deleteEmbedding,
  flushEmbeddings,
  getEmbedding,
  getKNearestNeighbors,
  releaseLock,
  upsertEmbedding
} from "./vectordb.js";
import * as crypto from "crypto";
import { addTagsToEvent } from "./llm/eventToTags.js";

// Deprecated
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

    // ---------------- CHECKING IF THE EMAIL HAS BEEN PROCESSED OR IGNORED BEFORE ----------------
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

    // Here are the emails that we need to fetch. 
    // I.e., the emails that have not been ignored or processed.
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
    const logger = new EmailProcessingLogger(auth.user);
    await logger.setup();

    // Have to ensure the property: For emails A & B, if A.receivedAt <= B.receivedAt, then
    // the promise processMail(..., A) must be created NO LATER THAN processMail(..., B).
    mailProcessors.push(
      ...fetchedEmails.map((email) =>
        processMail(
          prisma,
          auth.user,
          email.uid,
          emailToRelaxedParsedMail(email),
          processingTasks,
          logger
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
          .then((parsed) =>
            processMail(prisma, auth.user, message.uid, parsed, processingTasks, logger)
          )
          .then((value) => {
            if (value !== "dormspam-but-root-not-in-db") {
              const acryonyms: { [key in ProcessEmailResult]: string } = {
                "malformed-email": "M",
                "not-dormspam": "D",
                "dormspam-but-root-not-in-db": "R",
                "dormspam-but-not-event-by-gpt-3": "3",
                "dormspam-but-not-event-by-gpt-4": "4",
                "dormspam-processed-with-same-prompt": "P",
                "dormspam-but-network-error": "N",
                "dormspam-but-malformed-json": "J",
                "dormspam-with-event": "E"
              };
              process.stdout.write(acryonyms[value]);
            }
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
    console.log("");
    for (const [key, value] of resultsByType) console.log(`${key}: ${value}`);
  } finally {
    lock.release();
    await prisma.$disconnect();
    await client.logout();
  }
}

function fnv1aHash32(str: string): number {
  let hash = 0x811c9dc5; // 32-bit FNV-1a initial hash value
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // Multiply by the FNV prime and ensure 32-bit overflow
  }
  if (hash > 0x7FFFFFFF) {
    hash -= 0x100000000; // Wrap around using two's complement
  }
  return hash;
}

const generateUID = (email: ParsedMail): number => {
  // Getting rid of the "<" and ">" characters in the message ID.
  const messageId = email.messageId?.replace("<", "").replace(">", "") ?? "";
  if (messageId === "") {
    throw new Error("Invalid email message ID");
  }
  const uid = fnv1aHash32(messageId);
  return uid;
}

/**
 * Given an email parsed by the mailparser library's simpleParser function,
 * adds the email to the database. If the email is recognized as an event, an event will be added
 * to the DB and tags will be added.
 * @param {ParsedMail} email The parsed email.
 */
export async function processNewEmail(email: ParsedMail) {
  const prisma = new PrismaClient();
  try {
    const uid = generateUID(email);

    // Necessary to call existing version of processMail function
    const processingTasks = new Map<string, Deferred<void>>();
    const logger = new EmailProcessingLogger("sipb-mail-scripts");
    await logger.setup();


    const result: ProcessEmailResult = await processMail(prisma,
      "sipb-mail-scripts",
      uid,
      email,
      processingTasks,
      logger)

      .then((value) => {
        if (value !== "dormspam-but-root-not-in-db") {
          const acryonyms: { [key in ProcessEmailResult]: string } = {
            "malformed-email": "M",
            "not-dormspam": "D",
            "dormspam-but-root-not-in-db": "R",
            "dormspam-but-not-event-by-gpt-3": "3",
            "dormspam-but-not-event-by-gpt-4": "4",
            "dormspam-processed-with-same-prompt": "P",
            "dormspam-but-network-error": "N",
            "dormspam-but-malformed-json": "J",
            "dormspam-with-event": "E"
          };
          process.stdout.write(acryonyms[value]);
        }
        return value;
      })

    console.log(`\n New email was of type: ${result}`)
    if (result === "dormspam-with-event") {
      console.log("Email was successfully processed and event(s) were extracted. Adding tags...");

      // Fetching the event(s) that should've been created if event(s) were extracted to add tags
      const events = await prisma.event.findMany({
        where: {
          fromEmailId: email.messageId
        }
      });
      if (events.length === 0) {
        console.error("Event(s) from email were not found in the database. Exiting...");
        return;
      }

      for (const event of events) {
        const tags = await addTagsToEvent(event);
        await updateEventTags(prisma, event, tags);
      }
    }
  }
  finally {
    await prisma.$disconnect();
  }
}

const updateEventTags = async (prisma: PrismaClient, event: Event, tags: Array<string>) => {
  console.log(`Event "${event.title}" has tags: ${tags}`);
  for (const tag of tags) {
    await prisma.event.update({
      where: { id: event.id },
      data: {
        tags: {
          connectOrCreate: {
            where: { name: tag },
            create: {
              name: tag,
              color: "",
              icon: "",
              category: ""
            }
          }
        }
      }
    });
  }
  await prisma.event.update({
    where: { id: event.id },
    data: { tagsProcessedBy: CURRENT_MODEL_NAME }
  });
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
  return isDormspamRegex.test(text) && !text.includes("dormsoup-ignore");
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

type ProcessEmailResult =
  | "malformed-email"
  | "not-dormspam"
  | "dormspam-but-root-not-in-db"
  | "dormspam-but-not-event-by-gpt-3"
  | "dormspam-but-not-event-by-gpt-4"
  | "dormspam-processed-with-same-prompt"
  | "dormspam-but-network-error"
  | "dormspam-but-malformed-json"
  | "dormspam-with-event";

async function processMail(
  prisma: PrismaClient,
  scrapedBy: string,
  uid: number,
  parsed: RelaxedParsedMail,
  processingTasks: Map<string, Deferred<void>>,
  logger: EmailProcessingLogger
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

    if (
      messageId === undefined ||
      from === undefined ||
      from.value[0].address === undefined ||
      (html === undefined && parsed.text === undefined) ||
      subject === undefined
    ) {
      logger.logMalformed(uid, parsed, "header malformed");
      await ignoreThisEmailForever();
      return "malformed-email";
    }

    const emailWithSameMessageId = await prisma.email.findUnique({ where: { messageId } });
    if (emailWithSameMessageId !== null && emailWithSameMessageId.uid !== uid) {
      logger.logMalformed(uid, parsed, "duplicate message ID");
      await ignoreThisEmailForever();
      return "malformed-email";
    }

    const sender = from.value[0];
    const senderAddress = sender.address!!;
    const senderName = sender.name ?? senderAddress;

    const text = removeArtifacts(parsed.text ?? (html ? convert(html) : ""));
    if (!isDormspam(text)) {
      await ignoreThisEmailForever();
      return "not-dormspam";
    }

    let inReplyTo = undefined;
    let rootMessageId = messageId;
    const dormspamLogger = logger.loggerForDormspam(uid, parsed);
    let metaBlock =
      `Run date: ${new Date().toISOString()}\n` +
      `Received at: ${receivedAt.toISOString()}\n` +
      `Scraped by: ${scrapedBy}\n` +
      `Sent by: ${senderName}<${senderAddress}>\n`;
    dormspamLogger.logBlock("meta", metaBlock);

    if (parsed.inReplyTo !== undefined) {
      const inReplyToEmail = await prisma.email.findUnique({
        where: { messageId: parsed.inReplyTo }
      });
      if (inReplyToEmail === null) return "dormspam-but-root-not-in-db";
      let root = inReplyToEmail;
      const thread = [];
      while (root.inReplyToId !== null) {
        const nextRoot = await prisma.email.findUnique({ where: { messageId: root.inReplyToId } });
        if (nextRoot === null) return "dormspam-but-root-not-in-db";
        thread.push(`${root.inReplyToId} ${nextRoot.subject}`);
        root = nextRoot;
      }
      dormspamLogger.logBlock("thread", thread.join("\n"));
      rootMessageId = root.messageId;
      inReplyTo = {
        connect: { messageId: parsed.inReplyTo }
      };

      const prevDeferred = processingTasks.get(inReplyToEmail.messageId);
      if (prevDeferred !== undefined) await prevDeferred.promise;
    }

    console.log("\nSubject", subject, "uid", uid);

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
        body: html ? html : parsed.text ?? "",
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

    let shouldSendReply = false;

    if (existing !== null) {
      // The existing email has already been processed with the current model, do nothing.
      // if (receivedAt < existing.latestUpdateTime) return;
      if (existing.fromEmail?.modelName === CURRENT_MODEL_NAME) {
        await markProcessedByCurrentModel();
        return "dormspam-processed-with-same-prompt";
      }
      // The existing email has been processed by an older model / prompt. Delete all associated
      // events.
      await prisma.event.deleteMany({ where: { fromEmailId: rootMessageId } });
    } else {
      // There is no existing parses of this email.
      shouldSendReply = true;
    }

    const result = await extractFromEmail(subject, text, receivedAt, dormspamLogger);

    if (result.status === "error-malformed-json") return "dormspam-but-malformed-json";
    if (result.status === "error-openai-network") return "dormspam-but-network-error";
    if (result.status === "rejected-by-gpt-3") {
      await markProcessedByCurrentModel();
      return "dormspam-but-not-event-by-gpt-3";
    }
    if (result.status === "rejected-by-gpt-4") {
      await markProcessedByCurrentModel();
      return "dormspam-but-not-event-by-gpt-4";
    }

    if (result.events.length > 0) console.log(`\nFound events in email: ${parsed.subject}`);

    await acquireLock();
    let eventsToSend = [];
    try {
      outer: for (const event of result.events) {
        const embedding = await createEmbedding(event.title);
        const knn = getKNearestNeighbors(embedding, 3);
        upsertEmbedding(event.title, embedding, { eventIds: [] });
        dormspamLogger.logBlock(
          `knn-${event.title}`,
          knn.map(([title, distance]) => `${distance} ${title}`).join("\n")
        );
        const newEventData = {
          date: event.dateTime,
          source: DataSource.DORMSPAM,
          title: event.title,
          location: event.location,
          organizer: event.organizer,
          duration: event.duration,
          fromEmail: { connect: { messageId: rootMessageId } },
          text
        };
        for (const [title, distance] of knn) {
          const { metadata } = getEmbedding(title)!;
          for (const eventId of metadata.eventIds) {
            const otherEvent = await prisma.event.findUnique({
              where: { id: eventId },
              include: { fromEmail: { select: { receivedAt: true } } }
            });
            if (otherEvent === null) {
              console.warn("Event id ", eventId, " is in embedding DB metadata but not in DB");
              continue;
            }
            let mergeBlock =
              `New event: ${event.title} ${event.dateTime.toISOString()} ${event.location}\n` +
              `Old event: ${otherEvent.title} ${otherEvent.date.toISOString()} ${otherEvent.location
              }\n`;
            const merged = mergeEvents(
              { ...event, date: event.dateTime, fromEmail: { receivedAt } },
              otherEvent
            );
            mergeBlock += `Merged: ${merged}\n`;
            dormspamLogger.logBlock(`merge`, mergeBlock);
            if (merged === "latter") {
              console.log("Event ", event, " not inserted because it is merged with ", otherEvent);
              continue outer;
            }
            if (merged === "former") {
              upsertEmbedding(event.title, embedding, { eventIds: [eventId] });
              metadata.eventIds = metadata.eventIds.filter((id) => id !== eventId);
              if (metadata.eventIds.length === 0) deleteEmbedding(title);
              console.log("Event ", event, " updates previous event ", otherEvent);
              await prisma.event.update({
                where: { id: eventId },
                data: newEventData
              });
              continue outer;
            }
          }
        }
        const newEvent = await prisma.event.create({ data: newEventData });
        upsertEmbedding(event.title, embedding, { eventIds: [newEvent.id] });
        eventsToSend.push(newEvent);
        console.log("Event ", event, " inserted ");
      }
    } finally {
      releaseLock();
    }

    markProcessedByCurrentModel();
    if (shouldSendReply && eventsToSend.length > 0) {
      await sendReply(senderAddress, messageId, eventsToSend);
    }

    return "dormspam-with-event";
  } finally {
    deferred.resolve();
  }
}

const REPLY_TEMPLATE = dedent`
<body>
  <p>
    Hi Dormspammer!
  </p>
  <p>
    Our large language model just parsed your email and identified the following event(s):
  </p>
  {EVENTS}
  <p>
    You can find your event(s) at <a
    href="https://dormsoup.mit.edu">dormsoup.mit.edu</a> and edit any of the
    above details.
  </p>
  <p>
    If you have any questions, feel free to contact <a
    href="mailto:dormsoup@mit.edu">dormsoup@mit.edu</a> or visit <a
    href="https://dormsoup.mit.edu/about">our about page</a> for our data
    privacy policy. If you would like our model to NOT parse your emails,
    include "dormsoup-ignore" anywhere in your email.
  </p>
  <p>
    DormSoup Team
  </p>
</body>
`;
const REPLY_EVENT_TEMPLATE = dedent`
  <p>
    Title: <b>{EVENT_TITLE}</b><br>
    Date / Time: {EVENT_TIME}<br>
    Location: {EVENT_LOCATION}
  </p>
  `;

async function sendReply(senderAddress: string, messageId: string, events: Event[]) {
  console.log("Sending reply to ", senderAddress);
  const subject = "[DormSoup] Your event is on DormSoup!";
  if (false && senderAddress !== "andiliu@mit.edu") {
    return;
  }
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  const paragraphs = events.map((event) => {
    const eventDate = event.date.toISOString().split("T")[0]; // YYYY-MM-DD
    const eventTime = event.date.toISOString().split("T")[1].slice(0, 5); // HH:MM
  
    const formattedTime = isAllDay(event.date) ? eventDate : `${eventDate} ${eventTime}`;
  
    return REPLY_EVENT_TEMPLATE.replace("{EVENT_TITLE}", event.title)
      .replace("{EVENT_TIME}", formattedTime)
      .replace("{EVENT_LOCATION}", event.location);
  });
  const html = REPLY_TEMPLATE.replace("{EVENTS}", paragraphs.join("\n"));
  await sendEmail({
    to: senderAddress,
    subject: subject,
    inReplyTo: messageId,
    html
  });
}

function mergeEvents(
  event1: { date: Date; location: string; fromEmail: null | { receivedAt: Date } },
  event2: { date: Date; location: string; fromEmail: null | { receivedAt: Date } }
): "unmergable-date" | "unmergable-location" | "former" | "latter" {
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  // Get the day since unix epoch
  const sameDate =
    ((isAllDay(event1.date) || isAllDay(event2.date)) &&
      Math.floor(event1.date.getTime() / 86400000) ===
      Math.floor(event2.date.getTime() / 86400000)) ||
    event1.date.getTime() === event2.date.getTime();
  if (!sameDate) return "unmergable-date";
  const sameLocation =
    event1.location.toLowerCase() === "unknown" ||
    event2.location.toLowerCase() === "unknown" ||
    event1.location.toLowerCase().includes(event2.location.toLowerCase()) ||
    event2.location.toLowerCase().includes(event1.location.toLowerCase());
  if (!sameLocation) return "unmergable-location";
  return event1.fromEmail!.receivedAt <= event2.fromEmail!.receivedAt ? "latter" : "former";
}

class EmailProcessingLogger {
  public constructor(private scrapedBy: string) { }

  public async setup() {
    await fs.promises.mkdir(`logs/${this.scrapedBy}`, { recursive: true });
    await fs.promises.appendFile(`logs/${this.scrapedBy}/malformed.log`, "");
  }

  public logMalformed(uid: number, parsed: RelaxedParsedMail, reason: string) {
    const { messageId, from, html, subject } = parsed;
    // DO NOT AWAIT
    fs.promises.appendFile(
      `logs/${this.scrapedBy}/malformed.log`,
      `${uid.toString().padStart(5, "0")} ${messageId} ${JSON.stringify(
        from
      )} ${html} ${subject} ${reason}\n`
    );
  }

  public loggerForDormspam(uid: number, parse: RelaxedParsedMail) {
    const fileName = `logs/${this.scrapedBy}/${uid.toString().padStart(5, "0")}-${filenamify(
      parse.subject!!
    )}.log`;
    return new SpecificDormspamProcessingLogger(fileName);
  }
}

export class SpecificDormspamProcessingLogger {
  public constructor(private fileName: string) { }

  public logBlock(name: string, value: string) {
    const maxBannerLength = 100;
    let banner = name.toUpperCase();
    let bannerEnd = banner;
    if (name.length < maxBannerLength) {
      const rest = maxBannerLength - name.length;
      const firstHalf = Math.floor(rest / 2);
      bannerEnd = "<".repeat(firstHalf) + banner + "<".repeat(rest - firstHalf);
      banner = ">".repeat(firstHalf) + banner + ">".repeat(rest - firstHalf);
    }
    // DO NOT AWAIT
    fs.promises.appendFile(this.fileName, `${banner}\n${value}\n${bannerEnd}\n`);
  }
}