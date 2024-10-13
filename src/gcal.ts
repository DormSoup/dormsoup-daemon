import path from "path";
import { promises as fs } from "fs";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
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

export const GCAL_ID = process.env.GOOGLE_CALENDAR_ID;

export async function getGCal() {
  const auth = await authorize();
  return google.calendar({ version: "v3", auth });
}
