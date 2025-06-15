
import { convert } from "html-to-text";
import { Source, simpleParser } from "mailparser";
import { isDormspam, mergeEvents } from "../emailToEvents.js";
import { Event, ExtractFromEmailResult, extractFromEmail } from "../llm/emailToEvents";
import { generateEventTags } from "../llm/eventToTags.js";
import fs from 'node:fs';
import { acquireLock, deleteEmbedding, getEmbedding, getKNearestNeighbors, releaseLock, upsertEmbedding } from "../vectordb.js";
import { createTitleEmbedding } from "../llm/utils.js";

type EventWithText = Event & { text: string }

/**
 * Print some debugging information (whether the message was parsed as dormspam),
 * then parse the email to extract the events and print this.
 *
 * @param message The raw email content, as a Buffer or string.
 * @returns A list of events
 */
export async function debugEmailToEvents(messageSource: Source): Promise<EventWithText[]> {
  const parsed = await simpleParser(messageSource, {
    skipImageLinks: true,
    skipHtmlToText: false
  });
  
  // Get text content from either the text field or by converting HTML if available
  let text: string;
  if (parsed.text) {
    text = parsed.text;
  } else if (parsed.html) {
    text = convert(parsed.html);
  } else {
    // If neither text nor HTML is available, use an empty string
    text = "";
    console.warn("Warning: Email has neither text nor HTML content");
  }

  console.log(text);
  console.log("Is this a dormspam email?", isDormspam(text));
  const result: ExtractFromEmailResult = await extractFromEmail(
    parsed.subject ?? "No subject",
    text,
    parsed.date ?? new Date()
  );
  console.log("Extracted event:", result);
  if (result.status === "admitted") {
    const events = result.events.map((event)=>({...event, text}));
    return events;
  } else {
    console.warn("The event was not successfully extracted");
    return [];
  }
}

export type EmailWithEvents = {
  scrapedBy: string;
  uid: number;
  messageId: string;
  inReplyToId: string | null;
  receivedAt: string; // ISO date string
  senderEmail: string;
  subject: string;
  body: string;
  processedBody: string | null;
  modelName: string;
  event: JSONEvent[];
};

export type EmailWithoutEvents = {
  scrapedBy: string;
  uid: number;
  messageId: string;
  inReplyToId: string | null;
  receivedAt: string; // ISO date string
  senderEmail: string;
  subject: string;
  body: string;
  processedBody: string | null;
  modelName: string;
};

/**
 * Print some debugging information (whether the message was parsed as dormspam),
 * then parse the email to extract the events and print this.
 *
 * @param email The primsa client email.
 * @returns A list of events
 */
export async function debugPrimsaEmailToEvents(email: EmailWithEvents | EmailWithoutEvents): Promise<Event[]> {
  
  // Get text content from either the text field or by converting HTML if available
  console.log('SUBJECT:', email.subject);
  console.log("Is this a dormspam email?", isDormspam(email.body));
  const result: ExtractFromEmailResult = await extractFromEmail(
    email.subject ?? "No subject",
    email.body,
    email.receivedAt ? new Date(email.receivedAt) : new Date()
  );
  console.log("Extracted result:", result);

  if ("event" in email) {
    const events = email.event.map(({title, date, location, organizer, duration})=>({title, date, location, organizer, duration}))
    console.log("Previously extracted events:", events ?? "None");
  } else {
    console.log("Previously extracted events: None");
  }

  if (result.status === "admitted") {
    const events = result.events;
    return events;
  } else {
    console.warn("The event was not successfully extracted");
    return [];
  }
};

export type JSONEvent  = {
    id: number;
    source: string;
    fromEmailId: string;
    text: string;
    title: string;
    organizer: string;
    date: string;
    location: string;
    duration: number;
    gcalId: string | null;
    tagsProcessedBy: string;
    tags: Array<string>;
};

/**
 * Logs the process of adding tags to a given event for debugging purposes.
 *
 * This function prints the event's title, the previously generated tags,
 * and the generated tags after invoking the current implementation of `addTagsToEvent`.
 *
 * @param event - The previously generated event object to generate tags for. (this event's
 * tags are compared to those that are generated after invoking the current implementation of 
 * `addTagsToEvent`.)
 * @returns A promise that resolves when the logging is complete.
 */
export async function debugGenerateTags(event: JSONEvent): Promise<void> {
    console.log("Tagging Event:", event.title);
    const prevTags = event.tags
    const generatedTags = await generateEventTags(event);
    console.log('Generated tags', generatedTags);
    console.log('Previously generated tags', prevTags);
}


/**
 * Parses an email file to extract event information and generate tags for each event.
 *
 * Reads the contents of the specified file, parses it into event objects,
 * and then generates tags for each event using the provided tag generation function.
 * Logs progress and results to the console.
 *
 * @param file - The path to the email file to be parsed.
 * @returns A Promise that resolves when all events have been processed and tagged.
 */
export async function eventFromEmailFile(file: fs.PathOrFileDescriptor){
    const contents = fs.readFileSync(file);
    const events = await debugEmailToEvents(contents);
    console.log("Done parsing event date/time!");
    
    console.log("Parsing tags from file is a working progress...") //:D")
    for (const event of events) {
        console.log("Tagging Event:", event.title);
        const generatedTags = await generateEventTags(event);
        console.log(`The following tags were generated ${generatedTags}`)
    }
}

export type MinimalDedupEvent = (Pick<Event, 'title' | 'dateTime' | 'location'> & { fromEmail: { receivedAt: Date } });


/**
 * Attempts to deduplicate a new event against a list of existing events using embedding-based similarity.
 * 
 * For each event in `otherEvents`, generates an embedding for its title and indexes it.
 * Then, generates an embedding for the `newEvent` title and finds its k-nearest neighbors.
 * 
 * For each neighbor:
 * - If the neighbor event can be merged and the neighbor is newer, skips insertion of `newEvent`.
 * - If the neighbor event can be merged and `newEvent` is newer, updates the embedding and associated metadata.
 * - If no suitable duplicate is found, logs that no duplicate was detected.
 * 
 * @param newEvent - The event to check for duplication and potentially insert.
 * @param otherEvents - The list of existing events to check against.
 */
export async function debugDedup(newEvent: MinimalDedupEvent, otherEvents: MinimalDedupEvent[]){
    await acquireLock();
    for (const [index, event] of otherEvents.entries()) {
      const embedding = await createTitleEmbedding(event.title);
      upsertEmbedding(event.title, embedding, { eventIds: [index] });
      console.log(`Indexed event at position ${index}:`, event.title);
    }

    const embedding = await createTitleEmbedding(newEvent.title);
    upsertEmbedding(newEvent.title, embedding, { eventIds: [] });

    const KNearestNeighbors = getKNearestNeighbors(embedding, 3);

    for (const [neighborTitle, neighborDistance] of KNearestNeighbors) {
      const { metadata: neighborMetadata } = getEmbedding(neighborTitle)!;
      for (const neighborEventId of neighborMetadata.eventIds) {

        const otherEvent = otherEvents[neighborEventId];

        if (otherEvent === null) {
          console.warn("Event id ", neighborEventId, " is in embedding DB metadata but not in DB");
          continue;
        }

        // check if we should merge with this neighborEvent of the neighbor
        const merged = mergeEvents(
          { ...newEvent, date: newEvent.dateTime},
          { ...otherEvent, date: otherEvent.dateTime},
        );

        // if any neighborEvent is mergable with this event
        // and is associated with a newer email, there is no need to insert the event into the
        // db, it is likely a dupe and we have the newer version already
        if (merged === "latter") {
          console.log("Event ", newEvent, " not inserted because it is merged with ", otherEvent);
          releaseLock();
          return;
        }

        // if any neighborEvent is mergable with this event
        // and the current email is the newer of the 2
        if (merged === "former") {
          // update the the embedding for this event title
          // add the neighborEvent to the list of events associated with this event's title
          upsertEmbedding(newEvent.title, embedding, { eventIds: [neighborEventId] });

          // we've already checked this event 
          neighborMetadata.eventIds = neighborMetadata.eventIds.filter((id) => id !== neighborEventId);
          
          // if the neighbor only had this neighborEvent, it is no longer nessecary since we
          // have this event to represent this title
          if (neighborMetadata.eventIds.length === 0) deleteEmbedding(neighborTitle);

          console.log("Event ", newEvent, " updates previous event ", otherEvent);
          releaseLock();
          return;
        }
      }
  }
  console.log("No dupe for ", newEvent, " found ");
  releaseLock();
}