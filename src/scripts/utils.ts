
import { convert } from "html-to-text";
import { Source, simpleParser } from "mailparser";
import { isDormspam } from "../emailToEvents.js";
import { Event, ExtractFromEmailResult, extractFromEmail } from "../llm/emailToEvents";
import { generateEventTags } from "../llm/eventToTags.js";
import fs from 'node:fs';

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