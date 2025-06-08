import {debugAddTagsToEvent, EmailWithEvents } from "./utils.js";
import fs from "fs/promises";
import { Event } from "@prisma/client";

// TODO: Comment this
async function main(): Promise<void> {
    const emailsWithEventsPath = 'testEmails/emails_with_events.json';
    const emailsWithEvents = JSON.parse(await fs.readFile(emailsWithEventsPath, "utf-8")) as EmailWithEvents[];
    
    for (const email of emailsWithEvents) {
        for (const event of email.event) {
            await debugAddTagsToEvent(event);
        }
    }
}

await main();
