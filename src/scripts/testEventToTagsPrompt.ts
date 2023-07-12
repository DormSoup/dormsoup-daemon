import { PrismaClient } from "@prisma/client";
import readline from "readline/promises";

import { addTagsToEvent } from "../llm/eventToTags.js";

export async function main() {
  const prisma = new PrismaClient();

  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const eventName = await readlineInterface.question("Event name: ");
    const event = await prisma.event.findFirstOrThrow({
      where: { title: { contains: eventName, mode: "insensitive" } }
    });
    console.log(event);
    console.log(await addTagsToEvent(event));
  } finally {
    readlineInterface.close();
    await prisma.$disconnect();
  }
}

await main();
