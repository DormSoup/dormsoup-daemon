import {debugGenerateTags, EmailWithEvents } from "./utils.js";
import fs from "fs/promises";
import { Event } from "@prisma/client";

/**
 * Tests the tag generation pipeline on previously tagged and event emails.
 *
 * @returns {Promise<void>} A promise that resolves when all events have been processed.
 */
async function main(): Promise<void> {
    const emailsWithEventsPath = 'testEmails/emails_with_events.json';
    const emailsWithEvents = JSON.parse(await fs.readFile(emailsWithEventsPath, "utf-8")) as EmailWithEvents[];
    
    for (const email of emailsWithEvents) {
        for (const event of email.event) {
            await debugGenerateTags(event);
        }
    }
}

await main();
