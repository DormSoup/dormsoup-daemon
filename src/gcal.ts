import path from "path";
import { promises as fs } from "fs";
import { authenticate } from "@google-cloud/local-auth";
import { calendar_v3, google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

// If modifying these scopes, delete token.json.
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first time.
const TOKEN_PATH = path.join(process.cwd(), "token.json");

const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const minuteToMS = 1000 * 60;
const thirtyDaysToMS = 30 * 24 * 60 * minuteToMS;
const tenMinutesToMS = minuteToMS * 10;

type PartialEvent = {
    id: number;
    title: string;
    date: Date;
    location: string;
    duration: number;
    fromEmail: {
        receivedAt: Date;
    } | null;
    gcalId: string | null;
    text: string;
};

/**
 * Attempts to load previously saved OAuth2 credentials from the file system.
 * 
 * @returns A promise that resolves to an `OAuth2Client` instance if credentials exist and are valid,
 * or `null` if the credentials file does not exist or cannot be parsed.
 */
async function loadSavedCredentialsIfExist(): Promise<OAuth2Client | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content.toString());
    return google.auth.fromJSON(credentials) as any;
  } catch (err) {
    return null;
  }
}


/**
 * Saves OAuth2 client credentials to a token file.
 *
 * @param client - The OAuth2Client instance containing the credentials to save.
 * @returns A promise that resolves when the credentials have been saved.
 * @throws If reading the credentials file or writing the token file fails.
 */
async function saveCredentials(client: OAuth2Client) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content.toString());
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: "authorized_user",
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Removes the trailing 'Z' (UTC marker) from the ISO string representation of a Date object.
 *
 * @param date - The Date object to convert and modify.
 * @returns The ISO string representation of the date without the trailing 'Z' character.
 * 
 * 
 */
const removeUTCMarker = (date: Date) => date.toISOString().replace(/Z$/, "");

function creategCalCreatedEventCallback (prisma: PrismaClient, event: PartialEvent){
  /**
   * Callback function to handle the result of creating a Google Calendar event.
   *
   * If an error occurs during the creation, it logs the error.
   * If the event is created but no ID is returned, it logs a warning.
   * Otherwise, it updates the corresponding event in the DormSoup database with the Google Calendar event ID.
   *
   * @param err - An error object if the Google Calendar API call failed, or null if successful.
   * @param gcalCreatedEvent - The response object from the Google Calendar API, potentially containing the created event data.
   */
  const gCalCreatedEventCallback = async (err: Error | null, 
    gcalCreatedEvent: { data?: calendar_v3.Schema$Event }) => {
    if (err) {
      console.log("There was an error contacting gcal: " + err);
      return;
    }

    if (!gcalCreatedEvent.data?.id) {
      console.log("Gcal event created, but no id returned: ", gcalCreatedEvent);
      return;
    }

    // Update the event in the DormSoup DB with the gcal id, to avoid re-creating it.
    try {
      console.log(`Updating event ${event.id} with gcal id ${gcalCreatedEvent.data.id}`);
      await prisma.event.update({
        where: { id: event.id },
        data: { gcalId: gcalCreatedEvent.data.id }
      });
    } catch (e) {
      console.error(`Error updating event ${event.title} with gcal id ${gcalCreatedEvent.data.id}: ${e}`);
    }
  };

  return gCalCreatedEventCallback;
}


/**
 * Authorizes and returns an OAuth2 client for accessing Google APIs.
 *
 * Attempts to load previously saved credentials. If credentials are not found,
 * initiates an authentication flow to obtain new credentials, saves them for future use,
 * and returns the authenticated client.
 *
 * Note: The authentication flow that requires user interaction should be performed locally
 * to generate a `token.json` file, which can then be copied to the server for headless operation.
 *
 * @returns {Promise<OAuth2Client>} A promise that resolves to an authorized OAuth2 client.
 */
async function authorize(): Promise<OAuth2Client> {
  const savedClient = await loadSavedCredentialsIfExist();
  if (savedClient) return savedClient as any;

  const authedClient = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if (authedClient.credentials) await saveCredentials(authedClient);
  return authedClient;
}

/**
 * Synchronizes the Google Calendar with recently created events from the database 
 * that have not yet been synced to Google Calendar.
 *
 * @returns {Promise<void>} A promise that resolves when the synchronization process is complete.
 */
export async function syncGCal() {
  console.log("Preparing to sync GCal...");

  const prisma = new PrismaClient();

  const auth = await authorize();
  const gcal = google.calendar({ version: "v3", auth });

  const today = new Date();
  const events = await getAllEventsCreatedRecently(today);

  console.log(`Found ${events.length} events to sync to GCal.`);

  for (const event of events) {
    // Shouldn't happen.
    if (event.gcalId) {
      console.log(`Event ${event.title} already has a gcalId: ${event.gcalId}`);
    }

    // If it was just created, wait a little bit before processing it. Tags, etc could still be updating.
    if (
      event.fromEmail?.receivedAt &&
      event.fromEmail.receivedAt.getTime() > (today.getTime() - tenMinutesToMS)
    ) {
      console.log(`Event ${event.title} was just created, waiting a bit before syncing to gcal.`);
      continue;
    }

    const gcalEvent = {
      summary: event.title,
      location: event.location,
      description: event.text,
      // The Z indicates UTC, but we want to use the America/New_York timezone.
      // andiliu: "we store time as if they are ISO when in fact they are in EST"
      start: {
        dateTime: removeUTCMarker(event.date), 
        timeZone: "America/New_York"
      },
      end: {
        dateTime: removeUTCMarker(new Date(event.date.getTime() + event.duration * minuteToMS)),
        timeZone: "America/New_York"
      }
    };

    const gCalCallback = creategCalCreatedEventCallback(prisma, event)
    gcal.events.insert(
      {
        auth: auth,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        // @ts-ignore
        resource: gcalEvent
      },
      gCalCallback
    )
  }
}


/**
 * Retrieves all events that were created recently (within the last 30 days) 
 * and do not have a Google Calendar ID (`gcalId`).
 *
 * @param today - The current date used as the upper bound for filtering events.
 * @returns A promise that resolves to an array of event objects,
 *  each containing the event's 
 *  - id, title, date, location, duration, receivedAt (fromEmail), gcalId, and text.
 * 
 * @throws if something goes wrong while querying with primsa.
 *
 * Notes: 
 * - Only events whose `fromEmail.receivedAt` is within the last 30 days (from `today`) are returned.
 * - Events that already have a `gcalId` are excluded.
 * - In case of an error, an empty array is returned and the error is logged to the console.
 */
export async function getAllEventsCreatedRecently(today: Date): Promise<PartialEvent[]> {
  const prisma = new PrismaClient();
  try {
    const events: PartialEvent[] = await prisma.event.findMany({
      where: {
        fromEmail: {
          receivedAt: {
            gte: new Date(today.getTime() - thirtyDaysToMS), // Up to 30 days ago.
            lt: today
          }
        },
        gcalId: null
      },
      select: {
        id: true,
        title: true,
        date: true,
        location: true,
        duration: true,
        fromEmail: { select: { receivedAt: true } },
        gcalId: true,
        text: true,
      }
    });
    return events;
  } catch (e) {
    console.error(e);
    return [];
  } finally {
    await prisma.$disconnect();
  }
}
