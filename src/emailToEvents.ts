import { DataSource, Email, Event, EmailSender, PrismaClient } from "@prisma/client";
import { Event as GeneratedEvent } from './llm/emailToEvents';
import dedent from "dedent";
import filenamify from "filenamify";
import fs from "fs";
import { convert } from "html-to-text";
import { AddressObject, ParsedMail } from "mailparser";
import { Deferred } from "./deferred.js";
import { CURRENT_EVENT_MODEL_DISPLAY_NAME, extractFromEmail } from "./llm/emailToEvents";
import { CURRENT_TAGGING_MODEL_DISPLAY_NAME } from "./llm/eventToTags";
import { generateEventTags as generateEventTags } from "./llm/eventToTags";
import { createTitleEmbedding, removeArtifacts } from "./llm/utils.js";
import { sendEmail } from "./mailer.js";
import {
  acquireLock,
  deleteEmbedding,
  getEmbedding,
  getKNearestNeighbors,
  releaseLock,
  upsertEmbedding
} from "./vectordb.js";
import dotenv from 'dotenv';
dotenv.config();

const numMSInDay = 86400000;

/**
 * Computes the 32-bit FNV-1a hash of a given string.
 *
 * @param str - The input string to hash.
 * @returns The 32-bit signed integer hash of the input string.
 */
function fnv1aHash32(str: string): number {
  let hash = 0x811c9dc5; // 32-bit FNV-1a initial hash value
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // Multiply by the FNV prime and ensure 32-bit overflow
  }
  if (hash > 0x7fffffff) {
    hash -= 0x100000000; // Wrap around using two's complement
  }
  return hash;
}

/**
 * Generates a unique 32-bit integer UID for an email based on its message ID.
 *
 * @param email - The parsed email object containing the message ID.
 * @returns A 32-bit integer UID derived from the email's message ID.
 * @throws {Error} If the email's message ID is missing or invalid.
 */
const generateUID = (email: ParsedMail): number => {
  // Getting rid of the "<" and ">" characters in the message ID.
  const messageId = email.messageId?.replace("<", "").replace(">", "") ?? "";
  if (messageId === "") {
    throw new Error("Invalid email message ID");
  }
  const uid = fnv1aHash32(messageId);
  return uid;
};

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

    const result: ProcessEmailResult = await processMail(
      prisma,
      "sipb-mail-scripts",
      uid,
      email,
      processingTasks,
      logger
    ).then((value) => {
      if (value !== "dormspam-but-root-not-in-db") {
        const acryonyms: { [key in ProcessEmailResult]: string } = {
          "malformed-email": "M",
          "not-dormspam": "D",
          "dormspam-but-root-not-in-db": "R",
          "dormspam-but-not-event-by-sipb-llms": "-1",
          "dormspam-but-not-event-by-sipb-llms-step-2": "-2",
          "dormspam-processed-with-same-prompt": "P",
          "dormspam-but-network-error": "N",
          "dormspam-but-malformed-json": "J",
          "dormspam-with-event": "E"
        };
        process.stdout.write(acryonyms[value]);
      }
      return value;
    });

    console.log(`\n New email was of type: ${result}`);
    if (result === "dormspam-with-event") {
      console.log("Email was successfully processed and event(s) were extracted. Adding tags...");

      // Fetching the event(s) that were created (since email is dormspam-with-event) to add tags
      const events = await prisma.event.findMany({
        where: {
          fromEmailId: email.messageId
        }
      });
      if (events.length === 0) {
        // dormspam-with-event => this shouldn't happen
        console.error("Event(s) from email were not found in the database. Exiting...");
        return;
      }

      // Tagging the event
      for (const event of events) {
        const tags = await generateEventTags(event);
        await addTagsToEvent(prisma, event, tags);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}


/**
 * Adds the provided tags to the given event in the database.
 *
 * @param prisma - The PrismaClient instance used for database operations.
 * @param event - The event object to add tags to.
 * @param tags - An array of tag names to add to the event.
 * @returns A Promise that resolves when all tag updates are complete.
 */
const addTagsToEvent = async (prisma: PrismaClient, event: Event, tags: Array<string>) => {
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
    data: { tagsProcessedBy: CURRENT_TAGGING_MODEL_DISPLAY_NAME }
  });
};

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


/**
 * Determines whether the provided text qualifies as dormspam.
 *
 * A text is considered dormspam if it matches the `isDormspamRegex` pattern
 * and does not contain the substring "dormsoup-ignore".
 *
 * @param text - The input string to evaluate.
 * @returns `true` if the text is dormspam; otherwise, `false`.
 */
export function isDormspam(text: string): boolean {
  return isDormspamRegex.test(text) && !text.includes("dormsoup-ignore");
}

type ShouldIgnoreEmailResult = "header malformed" | "duplicate message ID" | "not-dormspam";

type ProcessEmailResult =
  | "malformed-email"
  | "not-dormspam"
  | "dormspam-but-root-not-in-db"
  | "dormspam-but-not-event-by-sipb-llms"
  | "dormspam-but-not-event-by-sipb-llms-step-2"
  | "dormspam-processed-with-same-prompt"
  | "dormspam-but-network-error"
  | "dormspam-but-malformed-json"
  | "dormspam-with-event";


/**
 * Ignores an email by upserting a record into the `ignoredEmail` table.
 * If an entry with the given `scrapedBy` and `uid` exists, it is left unchanged.
 * Otherwise, a new entry is created with the provided `scrapedBy`, `uid`, and `receivedAt` values.
 *
 * @param prisma - The Prisma client instance used to interact with the database.
 * @param scrapedBy - The identifier for the source or method that scraped the email.
 * @param uid - The unique identifier of the email to ignore.
 * @param receivedAt - The date and time when the email was received.
 * @returns A promise that resolves when the upsert operation is complete.
 */
const ignoreThisEmailForever = async (prisma: PrismaClient, scrapedBy: string, 
  uid: number, receivedAt: Date) => {
    await prisma.ignoredEmail.upsert({
      where: { scrapedBy_uid: { scrapedBy, uid } },
      create: { scrapedBy, uid, receivedAt },
      update: {}
    });
  };

/**
 * Determines whether an email should be ignored permanently based on its content and metadata.
 *
 * This function checks for malformed headers, duplicate message IDs, and whether the email content
 * qualifies as "dormspam". If any of these conditions are met, it returns a corresponding reason string.
 * Otherwise, it returns `undefined`, indicating the email should not be ignored.
 *
 * @param prisma - The PrismaClient instance used to query the database for existing emails.
 * @param parsed - The parsed email object containing message details such as messageId, from, html, subject, and text.
 * @param uid - The unique identifier of the current email being processed.
 * @returns A promise that resolves to a `ShouldIgnoreEmailResult` string indicating the reason to ignore,
 *          or `undefined` if the email should not be ignored.
 */
async function shouldIgnoreForever(prisma: PrismaClient, parsed: ParsedMail, uid: number): 
  Promise<ShouldIgnoreEmailResult | undefined> {
  const { messageId, from, html, subject } = parsed;

  // if parsing the email seems to have failed, ignore the email
  if (messageId === undefined || from === undefined || from.value[0].address === undefined ||
  (html === undefined && parsed.text === undefined) || subject === undefined
  ) {
  return "header malformed";
  }

  // if there is another email with the same messageId, ignore the email
  const emailWithSameMessageId = await prisma.email.findUnique({ where: { messageId } });
  if (emailWithSameMessageId !== null && emailWithSameMessageId.uid !== uid) {
      return "duplicate message ID";
  }

  // if it isn't dormspam, ignore the email
  const text = removeArtifacts(parsed.text ?? (html ? convert(html) : ""));
  if (!isDormspam(text)) {
    return "not-dormspam";
  }

  return undefined;
}

type ProcessEmailThreadResponse = {
  inReplyTo: { connect: { messageId: string } } | undefined;
  rootMessageId: string | undefined;
};

/**
 * Processes an email thread by traversing the chain of replies to determine the root message
 * and constructs the appropriate relationship for the current email.
 *
 * If the email is a reply (`parsed.inReplyTo` is defined), the function attempts to find the
 * original email in the database and walks up the reply chain to the root message. It logs
 * the thread traversal and ensures that any previous emails in the thread are fully processed
 * before proceeding.
 *
 * @param prisma - The Prisma client instance for database access.
 * @param parsed - The parsed email object containing message details.
 * @param dormspamLogger - Logger for recording thread traversal and processing steps.
 * @param processingTasks - A map of message IDs to deferred processing tasks, used to ensure
 *                          correct processing order of related emails.
 * @returns An object containing the relationship (`inReplyTo`) and the root message ID (`rootMessageId`),
 *          or `undefined` if the root of the thread cannot be found in the database.
 */
async function processEmailThread(prisma: PrismaClient, 
  parsed: ParsedMail, 
  dormspamLogger: SpecificDormspamProcessingLogger, 
  processingTasks: Map<string, Deferred<void>>): Promise<undefined | ProcessEmailThreadResponse> {
      // Assume that the thread starts with current message
      let inReplyTo = undefined;
      let rootMessageId = parsed.messageId;

      if (parsed.inReplyTo !== undefined) {
        // if the email is in response to another, get the original email from the db
        const inReplyToEmail = await prisma.email.findUnique({
          where: { messageId: parsed.inReplyTo }
        });

        // if the email that was replied to is not in the db, root-not-in-db
        if (inReplyToEmail === null) return undefined;

        // set the root to be the email that was replied to
        let root = inReplyToEmail;

        // create an array to store the id and subject of all the emails in this email thread
        const thread = [];

        // while there is previous email that was replied to
        while (root.inReplyToId !== null) {
          // get previous email
          const nextRoot = await prisma.email.findUnique({ where: { messageId: root.inReplyToId } });

          // if not found, root-not-in-db
          if (nextRoot === null) return undefined;

          thread.push(`${root.inReplyToId} ${nextRoot.subject}`);

          // previous email is new root
          root = nextRoot; 
        }

        // log the email thread
        dormspamLogger.logBlock("thread", thread.join("\n"));

        rootMessageId = root.messageId;

        // create a relationship object for the email currently being parsed to the email it is
        // replying to
        inReplyTo = {
          connect: { messageId: parsed.inReplyTo }
        };

        // ensure that email that the current email is in response to has been processed
        const prevDeferred = processingTasks.get(inReplyToEmail.messageId);
        if (prevDeferred !== undefined) await prevDeferred.promise;
      }
    return {inReplyTo, rootMessageId}
}

/**
 * Processes a generated event by checking for duplicates or similar events using embeddings and k-nearest neighbors,
 * merges or updates existing events if necessary, and inserts new events into the database if no duplicates are found.
 * 
 * @param prisma - The PrismaClient instance for database operations.
 * @param event - The generated event to process.
 * @param dormspamLogger - Logger for dormspam-specific processing and debugging.
 * @param messageId - The unique message ID associated with the event's source email.
 * @param text - The full text content of the email.
 * @param receivedAt - The timestamp when the email was received.
 * @returns The created Event object, or undefined if the event was determined to be a duplicate.
 */
async function processGeneratedEvent(prisma: PrismaClient, event: GeneratedEvent, 
  dormspamLogger: SpecificDormspamProcessingLogger, messageId: string, text: string, receivedAt: Date): Promise<Event | undefined>{
   const embedding = await createTitleEmbedding(event.title);
    upsertEmbedding(event.title, embedding, { eventIds: [] });

    const KNearestNeighbors = getKNearestNeighbors(embedding, 3);
    
    // log k-nearest neighbors
    dormspamLogger.logBlock(
      `knn-${event.title}`,
      KNearestNeighbors.map(([title, distance]) => `${distance} ${title}`).join("\n")
    );

    const newEventData = {
      date: event.dateTime,
      source: DataSource.DORMSPAM,
      title: event.title,
      location: event.location,
      organizer: event.organizer,
      duration: event.duration,
      fromEmail: { connect: { messageId: messageId } },
      text
    };

    for (const [neighborTitle, neighborDistance] of KNearestNeighbors) {
      const { metadata: neighborMetadata } = getEmbedding(neighborTitle)!;
      for (const neighborEventId of neighborMetadata.eventIds) {

        const otherEvent = await prisma.event.findUnique({
          where: { id: neighborEventId },
          include: { fromEmail: { select: { receivedAt: true } } }
        });

        if (otherEvent === null) {
          console.warn("Event id ", neighborEventId, " is in embedding DB metadata but not in DB");
          continue;
        }

        let mergeBlock =
          `New event: ${event.title} ${event.dateTime.toISOString()} ${event.location}\n` +
          `Old event: ${otherEvent.title} ${otherEvent.date.toISOString()} ${
            otherEvent.location
          }\n`;

        // check if we should merge with this neighborEvent of the neighbor
        const merged = mergeEvents(
          { ...event, date: event.dateTime, fromEmail: { receivedAt } },
          otherEvent
        );

        // Log merge
        mergeBlock += `Merged: ${merged}\n`;
        dormspamLogger.logBlock(`merge`, mergeBlock);

        // if any neighborEvent is mergable with this event
        // and is associated with a newer email, there is no need to insert the event into the
        // db, it is likely a dupe and we have the newer version already
        if (merged === "latter") {
          console.log("Event ", event, " not inserted because it is merged with ", otherEvent);
          return;
        }

        // if any neighborEvent is mergable with this event
        // and the current email is the newer of the 2
        if (merged === "former") {
          // update the the embedding for this event title
          // add the neighborEvent to the list of events associated with this event's title
          upsertEmbedding(event.title, embedding, { eventIds: [neighborEventId] });

          // we've already checked this event 
          neighborMetadata.eventIds = neighborMetadata.eventIds.filter((id) => id !== neighborEventId);
          
          // if the neighbor only had this neighborEvent, it is no longer nessecary since we
          // have this event to represent this title
          if (neighborMetadata.eventIds.length === 0) deleteEmbedding(neighborTitle);

          console.log("Event ", event, " updates previous event ", otherEvent);
          await prisma.event.update({
            where: { id: neighborEventId },
            data: newEventData
          });
          return;
        }
      }
    }
    // if no dupe events were detected, create a new event in the db representing this event,
    // and add this event's id to the embedding of the title's associated events
    const newEvent = await prisma.event.create({ data: newEventData });
    upsertEmbedding(event.title, embedding, { eventIds: [newEvent.id] });
    console.log("Event ", event, " inserted ");
    return newEvent;
}


/**
 * Processes an incoming email, determines if it should be ignored or processed as a dormspam event,
 * extracts event information, updates the database, and potentially sends a reply to the sender.
 *
 * @param prisma - The Prisma client instance for database operations.
 * @param scrapedBy - Identifier for the entity that scraped the email.
 * @param uid - Unique identifier for the email.
 * @param parsed - The parsed email object.
 * @param processingTasks - A map of message IDs to deferred processing tasks for concurrency control.
 * @param logger - Logger instance for email processing and dormspam events.
 * @returns A promise that resolves to a `ProcessEmailResult` indicating the outcome of processing.
 */
async function processMail(
  prisma: PrismaClient,
  scrapedBy: string,
  uid: number,
  parsed: ParsedMail,
  processingTasks: Map<string, Deferred<void>>,
  logger: EmailProcessingLogger
): Promise<ProcessEmailResult> {
  const receivedAt = parsed.date ?? new Date();

  const { messageId, from, html, subject } = parsed;
  // This must come before any await, so that this can be synchronously executed once the promise
  // is created.
  const deferred = new Deferred<void>();
  try {
    const reasonToIgnore = await shouldIgnoreForever(prisma, parsed, uid);
    if (reasonToIgnore) {
      await ignoreThisEmailForever(prisma, scrapedBy, uid, receivedAt);
      if (reasonToIgnore !== 'not-dormspam'){
        logger.logMalformed(uid, parsed, reasonToIgnore);
        return "malformed-email";
      }
      return "not-dormspam";
    }

    processingTasks.set(messageId!, deferred); // shouldIgnoreForver checks if this is undefined
    
    const sender = from!.value[0]; // shouldIgnoreForver checks if this is undefined
    const senderAddress = sender.address!!;
    const senderName = sender.name ?? senderAddress;
    const text = removeArtifacts(parsed.text ?? (html ? convert(html) : ""));

    // it's dormspam, let's make a dormspam logger for the rest of the processing
    const dormspamLogger = logger.loggerForDormspam(uid, parsed);
    let metaBlock =
      `Run date: ${new Date().toISOString()}\n` +
      `Received at: ${receivedAt.toISOString()}\n` +
      `Scraped by: ${scrapedBy}\n` +
      `Sent by: ${senderName}<${senderAddress}>\n`;
    dormspamLogger.logBlock("meta", metaBlock);

    const inReplyTo = undefined;
    const rootMessageId = messageId;
    
    // email thread logic
    // const processEmailThreadResult = await processEmailThread(prisma, parsed, dormspamLogger, processingTasks);
    // if (processEmailThreadResult === undefined){
    //   return 'dormspam-but-root-not-in-db'
    // }

    // const {inReplyTo, rootMessageId} = processEmailThreadResult;

    console.log("\nSubject", subject, "uid", uid);

    // put the email in the db
    await prisma.email.upsert({
      where: { messageId: messageId! },
      create: {
        messageId: messageId!, // shouldIgnoreForver checks if this is undefined
        scrapedBy,
        uid,
        sender: {
          connectOrCreate: {
            where: { email: senderAddress },
            create: { email: senderAddress, name: senderName }
          }
        },
        subject: subject!, // shouldIgnoreForver checks if this is undefined
        body: html ? html : parsed.text ?? "",
        receivedAt,
        modelName: CURRENT_EVENT_MODEL_DISPLAY_NAME + "_PROCESSING",
        inReplyTo
      },
      update: { modelName: CURRENT_EVENT_MODEL_DISPLAY_NAME + "_PROCESSING" }
    });

    const markProcessedByCurrentModel = async () => {
      await prisma.email.update({ where: { messageId }, 
        data: { modelName: CURRENT_EVENT_MODEL_DISPLAY_NAME } });
    };

    // check for any events that already have the root of the email thread as its emailId
    const existing = await prisma.event.findFirst({
      where: { fromEmailId: rootMessageId },
      include: { fromEmail: { select: { modelName: true } } }
    });

    let shouldSendReply = false;

    // check if the existing event was processed with the current model
    if (existing !== null) {
      // If an existing event from this thread has already been processed with the current model, 
      // there is no need to process this email.
      if (existing.fromEmail?.modelName === CURRENT_EVENT_MODEL_DISPLAY_NAME) {
        await markProcessedByCurrentModel();
        return "dormspam-processed-with-same-prompt";
      }
      // The existing email has been processed by an older model / prompt. Delete all associated
      // events, process this event.
      await prisma.event.deleteMany({ where: { fromEmailId: rootMessageId } });
    } 
    else {
      // If there is no existing events from this thread, we should notify the user that their
      // event is on dormsoup.
      shouldSendReply = true;
    }

    // try to extract events from the email
    // subject variable is checked by ignore email
    const result = await extractFromEmail(subject!, text, receivedAt, dormspamLogger);

    // if events weren't detected, respond accordingly
    switch (result.status) {
      case "error-malformed-json":
        return "dormspam-but-malformed-json";
      case "error-sipb-llms-network":
        return "dormspam-but-network-error";
      case "rejected-by-sipb-llms":
        await markProcessedByCurrentModel();
        return "dormspam-but-not-event-by-sipb-llms";
      case "rejected-by-sipb-llms-step-2":
        await markProcessedByCurrentModel();
        return "dormspam-but-not-event-by-sipb-llms-step-2";
    }

    // events were detected!
    if (result.events.length > 0) console.log(`\nFound events in email: ${parsed.subject}`);

    // acquire access to the vectordb
    await acquireLock();
    
    const eventsToSend = [];
    try {
      for (const event of result.events) {
        const newEvent = await processGeneratedEvent(prisma, event, dormspamLogger, messageId!, text, receivedAt);
        if (newEvent !== undefined){
          eventsToSend.push(newEvent)
        }
      }
    } finally {
      releaseLock();
    }

    await markProcessedByCurrentModel();

    // notify the user of their email being parsed
    if (shouldSendReply && eventsToSend.length > 0) {
      await sendReply(senderAddress, messageId!, eventsToSend);
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
    Link on DormSoup: <a
    href="https://dormsoup.mit.edu?={EVENT_ID}">dormsoup.mit.edu?={EVENT_ID}</a>
  </p>
  `;

/**
 * Sends a reply email to the specified sender with details about their event(s) on DormSoup.
 *
 * @param senderAddress - The email address of the recipient to send the reply to.
 * @param messageId - The message ID of the original email to reply to.
 * @param events - An array of Event objects containing information about the events to include in the reply.
 * @returns A promise that resolves when the email has been sent.
 */
async function sendReply(senderAddress: string, messageId: string, events: Event[]) {
  if (process.env.DATABASE_URL == "postgresql://dormsoup:Hakken23@localhost:5432/dormsoup_dev"){
    return;
  }
  console.log("Sending reply to ", senderAddress);
  const subject = "[DormSoup] Your event is on DormSoup!";
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  const paragraphs = events.map((event) => {
    const eventDate = event.date.toISOString().split("T")[0]; // YYYY-MM-DD
    const eventTime = event.date.toISOString().split("T")[1].slice(0, 5); // HH:MM

    const formattedTime = isAllDay(event.date) ? eventDate : `${eventDate} ${eventTime}`;

    return REPLY_EVENT_TEMPLATE.replace("{EVENT_TITLE}", event.title)
      .replace("{EVENT_TIME}", formattedTime)
      .replace("{EVENT_LOCATION}", event.location)
      .replace("{EVENT_ID}", event.id.toString());
  });
  const html = REPLY_TEMPLATE.replace("{EVENTS}", paragraphs.join("\n"));
  await sendEmail({
    to: senderAddress,
    subject: subject,
    inReplyTo: messageId,
    html
  });
}

/**
 * Determines whether two event objects can be merged based on their date and location,
 * and if so, identifies which event is the "former" or "latter" based on their received time.
 *
 * @param event1 - The first event object, containing a date, location, 
 * and optional fromEmail with receivedAt timestamp.
 * 
 * @param event2 - The second event object, containing a date, location, 
 * and optional fromEmail with receivedAt timestamp.
 * 
 * @returns 
 * - `"unmergable-date"` if the events do not occur on the same day or at the same time.
 * - `"unmergable-location"` if the events do not occur at the same or compatible locations.
 * - `"former"` if `event1` is more recent than `event2`.
 * - `"latter"` if `event2` is more recent than `event1`.
 */
export function mergeEvents(
  event1: { date: Date; location: string; fromEmail: null | { receivedAt: Date } },
  event2: { date: Date; location: string; fromEmail: null | { receivedAt: Date } }
): "unmergable-date" | "unmergable-location" | "former" | "latter" {
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  // Whether one of the events are classified as all day and the events happend on the same day
  // or at the same time
  const sameDate =
    ((isAllDay(event1.date) || isAllDay(event2.date)) &&
      Math.floor(event1.date.getTime() / numMSInDay) ===
        Math.floor(event2.date.getTime() / numMSInDay)) ||
    event1.date.getTime() === event2.date.getTime();

  // if they don't seem to happen at the same time we can't merge them
  if (!sameDate) return "unmergable-date";

  // Whether one of the event locations is unknown 
  // or one of the event locations have the other in it
  const sameLocation =
    event1.location.toLowerCase() === "unknown" ||
    event2.location.toLowerCase() === "unknown" ||
    event1.location.toLowerCase().includes(event2.location.toLowerCase()) ||
    event2.location.toLowerCase().includes(event1.location.toLowerCase());

  // if they don't seem to be at the same place or we don't know where one is we cannot merge them
  if (!sameLocation) return "unmergable-location";

  // former if event1 is newer, latter if event2 is newer
  return event1.fromEmail!.receivedAt <= event2.fromEmail!.receivedAt ? "latter" : "former";
}

/**
 * Handles logging for email processing operations, including setup of log directories,
 * logging of malformed emails, and creation of specific loggers for individual emails.
 *
 * @remarks
 * This logger is intended to be used in the context of scraping and processing emails,
 * providing persistent logs for malformed messages and per-email processing details.
 */
class EmailProcessingLogger {
  /**
   * Creates an instance of the class.
   * @param scrapedBy - Identifier for the entity or process that performed the scraping.
   */
  public constructor(private scrapedBy: string) {}

  /**
   * Sets up the necessary logging directories and files for the current scraper instance.
   * 
   * This method creates a directory under `logs/` named after the `scrapedBy` property,
   * ensuring that the directory exists (creating it recursively if needed). It also ensures
   * that a `malformed.log` file exists within that directory, creating an empty file if it does not.
   * 
   * @returns {Promise<void>} A promise that resolves when the setup is complete.
   */
  public async setup() {
    await fs.promises.mkdir(`logs/${this.scrapedBy}`, { recursive: true });
    await fs.promises.appendFile(`logs/${this.scrapedBy}/malformed.log`, "");
  }

  /**
   * Logs information about a malformed email to a file.
   * 
   * This method appends a line to a log file specific to the current scraper, containing
   * the UID, message ID, sender information, HTML content, subject, and a reason for
   * why the email was considered malformed. The operation is intentionally not awaited.
   *
   * @param uid - The unique identifier of the email message.
   * @param parsed - The parsed email object containing message details.
   * @param reason - A string describing why the email was considered malformed.
   */
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

  /**
   * Creates and returns a logger instance for processing a specific dormspam email.
   *
   * @param uid - The unique identifier for the email.
   * @param parse - The parsed email object containing metadata such as the subject.
   * @returns An instance of `SpecificDormspamProcessingLogger` configured to log to a file
   *          named using the `scrapedBy` property, the padded UID, and a sanitized subject.
   */
  public loggerForDormspam(uid: number, parse: RelaxedParsedMail) {
    const fileName = `logs/${this.scrapedBy}/${uid.toString().padStart(5, "0")}-${filenamify(
      parse.subject!!
    )}.log`;
    return new SpecificDormspamProcessingLogger(fileName);
  }
}

/**
 * Logger class for processing and recording specific dormspam emails to a file.
 *
 * This class provides a method to log named blocks of text to a specified file,
 * formatting the block name as a banner for readability. The log entries are appended
 * asynchronously to the file without awaiting the operation.
 *
 * @param fileName - The path to the file where logs will be appended.
 */
export class SpecificDormspamProcessingLogger {

  /**
   * Creates an instance of the class.
   * @param fileName the filepath to write to
   */
  public constructor(private fileName: string) {}

  /**
   * Logs a value to a file with a visually distinctive banner for easier identification.
   *
   * The banner is constructed using the provided `name`, padded with '>' characters on top
   * and '<' characters on the bottom to reach a fixed width (`maxBannerLength`). The value is
   * written between the banners. The operation is asynchronous and not awaited.
   *
   * @param name - The label or title to display in the banner.
   * @param value - The string content to log beneath the banner.
   */
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
