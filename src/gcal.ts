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

async function loadSavedCredentialsIfExist(): Promise<OAuth2Client | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content.toString());
    return google.auth.fromJSON(credentials) as any;
  } catch (err) {
    return null;
  }
}

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

async function authorize(): Promise<OAuth2Client> {
  const savedClient = await loadSavedCredentialsIfExist();
  if (savedClient) return savedClient as any;

  // This doesn't really work on a server, do this step locally to
  // get a `token.json` file, and then copy it over to the server.
  const authedClient = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if (authedClient.credentials) await saveCredentials(authedClient);
  return authedClient;
}

export async function syncGCal() {
  console.log("Preparing to sync GCal...");

  const prisma = new PrismaClient();

  const auth = await authorize();
  const gcal = google.calendar({ version: "v3", auth });

  const today = new Date();
  const events = await getAllEventsCreatedRecently(today);

  console.log(`Found ${events.length} events to sync to GCal.`);

  for (const event of events) {
    // This shouldn't be needed as we also filter at the query level but just in case.
    if (event.gcalId) {
      console.log(`Event ${event.title} already has a gcalId: ${event.gcalId}`);

    }

    // If it was just created, wait a little bit before processing it. Tags, etc could still be updating.
    if (
      event.fromEmail?.receivedAt &&
      event.fromEmail.receivedAt.getTime() > (today.getTime() - 1000 * 60 * 10) // 10 minutes.
    ) {
      console.log(`Event ${event.title} was just created, waiting a bit before syncing to gcal.`);
      continue;
    }

    // Remove the Z suffix from ISO string to avoid timezone issues with Google Calendar
    // API The Z indicates UTC, but we want to use the America/New_York timezone.
    // andiliu: "we store time as if they are ISO when in fact they are in EST"
    const removeUTCMarker = (date: Date) => date.toISOString().replace(/Z$/, "");

    const gcalEvent = {
      summary: event.title,
      location: event.location,
      description: event.text,
      start: {
        dateTime: removeUTCMarker(event.date),
        timeZone: "America/New_York"
      },
      end: {
        dateTime: removeUTCMarker(new Date(event.date.getTime() + event.duration * 60 * 1000)), // Duration is in minutes.
        timeZone: "America/New_York"
      }
    };

    gcal.events.insert(
      {
        auth: auth,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        // @ts-ignore
        resource: gcalEvent
      },
      async function (err: Error | null, gcalCreatedEvent: { data?: calendar_v3.Schema$Event }) {
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
      }
    );
  }
}

export async function getAllEventsCreatedRecently(today: Date) {
  const prisma = new PrismaClient();
  try {
    const events = await prisma.event.findMany({
      where: {
        fromEmail: {
          receivedAt: {
            gte: new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000), // Up to 30 days ago.
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
