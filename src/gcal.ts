import path from "path";
import { promises as fs } from "fs";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { getAllEvents } from "./subscription";
import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
dotenv.config();

// If modifying these scopes, delete token.json.
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
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

  const authedClient = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH
  });
  if (authedClient.credentials) await saveCredentials(authedClient);
  return authedClient;
}

export async function syncGCal() {
  const prisma = new PrismaClient();

  const auth = await authorize();
  const gcal = google.calendar({ version: "v3", auth });

  const today = new Date();
  const events = await getAllEvents(today);

  for (const event of events) {
    if (event.gcalId) {
      console.log(`Event ${event.title} already has a gcalId: ${event.gcalId}`);
      continue;
    }

    // If it was just created, wait a little bit before processing it. Tags, etc could still be updating.
    if (
      event.fromEmail?.receivedAt &&
      event.fromEmail.receivedAt.getTime() > today.getTime() - 1000 * 60 * 30 // 30 minutes.
    ) {
      console.log(`Event ${event.title} was just created, waiting a bit before syncing to gcal.`);
      continue;
    }

    const gcalEvent = {
      summary: event.title,
      location: event.location,
      description: `Organized by ${event.organizer}. Tags: ${event.tags
        .map((tag) => tag.name)
        .join(", ")}.`,
      start: {
        dateTime: event.date.toISOString(),
        timeZone: "America/New_York"
      },
      end: {
        // Just assume it ends 1 hour after it starts, for now.
        dateTime: new Date(event.date.getTime() + 60 * 60 * 1000).toISOString(),
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
      function (err: any, event: any) {
        if (err) {
          console.log("There was an error contacting gcal: " + err);
          return;
        }

        console.log("Gcal event created: %s", event.htmlLink);

        prisma.event.update({
          where: { id: event.id },
          data: { gcalId: event.id }
        });
      }
    );
  }
}
