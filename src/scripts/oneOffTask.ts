import { PrismaClient } from "@prisma/client";

import { removeArtifacts } from "../llm/utils.js";

export async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const allEvents = await prisma.event.findMany({
      select: { id: true, title: true, text: true }
    });
    for (const event of allEvents) {
      if (event.text.length > 100000) {
        console.log(`Event "${event.title} has absurdly long text (${event.text.length})`);
        const removed = removeArtifacts(event.text);
        if (removed.length < 100000) {
          await prisma.event.update({ where: { id: event.id }, data: { text: removed } });
          console.log("  fixed by removing artifacts");
        } else {
          console.log("  still very long after removal: ", removed);
        }
      }
      // await prisma.event.update({
      //   where: { id: event.id },
      //   data: { text: removeArtifacts(event.text) }
      // });
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
