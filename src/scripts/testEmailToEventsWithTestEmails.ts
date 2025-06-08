import {debugPrimsaEmailToEvents, EmailWithEvents, EmailWithoutEvents } from "./utils.js";
import fs from "fs/promises";

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
    const emailsWithoutEventsPath = 'testEmails/emails_with_events.json'
    const emailsWithEvents = JSON.parse(await fs.readFile(emailsWithEventsPath, "utf-8")) as EmailWithEvents[];
    const emailsWithoutEvents = JSON.parse(await fs.readFile(emailsWithoutEventsPath, "utf-8")) as EmailWithoutEvents[];
    
    console.log("EMAILS WITH EVENTS:")
    emailsWithEvents.forEach((email)=>debugPrimsaEmailToEvents(email));

    console.log("EMAILS WITHOUT EVENTS:")
    emailsWithoutEvents.forEach((email)=>debugPrimsaEmailToEvents(email));
}

await main();
