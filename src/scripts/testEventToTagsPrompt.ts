import { PrismaClient } from "@prisma/client";
import readline from "readline/promises";

import { generateEventTags } from "../llm/eventToTags";

/**
 * Runs an interactive CLI script to fetch events from the database and generate tags for them.
 * 
 * Prompts the user for an event name and whether to fetch all matching events or just the first one.
 * For each selected event, prints the event details and the generated tags.
 * 
 * @async
 * @returns {Promise<void>} Resolves when the script completes.
 */
export async function main() {
  process.env.DEBUG_MODE = "true";
  const prisma = new PrismaClient();

  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const eventName = await readlineInterface.question("Event name: ");
    const getAllEvents = await readlineInterface.question("Get all events? (y/N): ")
    if (getAllEvents.toLowerCase() === "y") {
      const events = await prisma.event.findMany({
        where: { title: { contains: eventName, mode: "insensitive" } }
      });
      if (events.length === 0) {
        throw Error(`No events with provided event name ${eventName} were found.`)
      }
      for (const event of events) {
        console.log(event)
        console.log(await generateEventTags(event))
      }
    } else {
      const event = await prisma.event.findFirstOrThrow({
        where: { title: { contains: eventName, mode: "insensitive" } }
      });
      console.log(event);
      console.log(await generateEventTags(event));
    }
  } finally {
    readlineInterface.close();
    await prisma.$disconnect();
  }
}

await main();
