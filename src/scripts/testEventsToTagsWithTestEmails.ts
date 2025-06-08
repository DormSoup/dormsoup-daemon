import {debugAddTagsToEvent, EmailWithEvents } from "./utils.js";
import fs from "fs/promises";
import { Event } from "@prisma/client";

// Good test cases
// Event with multiple times (same location): Ascension
// Multiple events with different times & locations: Pride Month Events
// Event with a speaker that might be mistaken as organizer: UN x MIT
// Not event: Senior Sale
// Long event: DormSoup Newsletter Test
// Hiring actors for future event: Seeking Directorial and Production Staff for THE FANTASTICKS
// Volunteering Oppurtunity: Teach CS to Under-resourced High Schoolers
// Selling tickets: 100 gecs
// Looking for tickets: Looking for ADT Thursday5/18 9-11pm Tickets

async function main(): Promise<void> {
    process.env.DEBUG_MODE = "true";
    const emailsWithEventsPath = 'testEmails/emails_with_events.json';
    const emailsWithEvents = JSON.parse(await fs.readFile(emailsWithEventsPath, "utf-8")) as EmailWithEvents[];
    
    emailsWithEvents.forEach((email)=>
        email.event
        .forEach(event =>{
            debugAddTagsToEvent(event);
        })
    );
}

await main();
