import { PrismaClient } from "@prisma/client";
import readline from "readline/promises";

import { addTagsToEvent } from "../llm/eventToTags";

// TODO: Comment this
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
        console.log(await addTagsToEvent(event))
      }
    } else {
      const event = await prisma.event.findFirstOrThrow({
        where: { title: { contains: eventName, mode: "insensitive" } }
      });
      console.log(event);
      console.log(await addTagsToEvent(event));
    }
  } finally {
    readlineInterface.close();
    await prisma.$disconnect();
  }
}

await main();
