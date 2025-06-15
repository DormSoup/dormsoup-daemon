import assert from "assert";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { simpleParser } from "mailparser";

import { processNewEmail } from "./emailToEvents";
import { pushToSubscribers } from "./subscription";
import { flushEmbeddings } from "./vectordb";
import { syncGCal } from "./gcal";

dotenv.config();
const MAIL_SCRIPTS_TOKEN = process.env.MAIL_SCRIPTS_TOKEN;
assert(MAIL_SCRIPTS_TOKEN !== undefined, "MAIL_SCRIPTS_TOKEN environment variable must be set");
const app = express();
const port = 4001;
app.use(express.json({ limit: "50mb" })); // Could be lowered, default is too low and was blocking


/**
 * Starts the background server process that logs the start time, ends any active console group,
 * and sets up a recurring interval (every 60 seconds) to:
 * - Push updates to subscribers
 * - Flush embeddings
 * - Synchronize events with Google Calendar
 *
 * @returns {void}
 */
const startServer = () => {
  console.log(`[${new Date().toISOString()}] Start pulling and parsing emails:`);
  console.groupEnd();
  setInterval(async () => {
    await pushToSubscribers();
    await flushEmbeddings();
    await syncGCal();
  }, 1000 * 60);
};

startServer();

/**
 * Handles incoming email POST requests from the mailscripts process.
 */
app.post("/eat", async (req: Request, res: Response) => {
  try {
    if (MAIL_SCRIPTS_TOKEN !== req.body.token) {
      console.log("Got request, but token was invalid. This request will be ignored.");
      return;
    }
    const email = await simpleParser(req.body.email);
    console.log(`Got email, subject: "${email?.subject}". Processing...`);
    processNewEmail(email);
    res.status(200).send("OK");
  } catch (e) {
    console.log(`Failed to parse email: ${e}`);
    res.status(400).send(`Dormsoup's simpleParser failed to parse email: ${e}`);
    return;
  }
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
