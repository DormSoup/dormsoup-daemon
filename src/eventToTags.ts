import { PrismaClient } from "@prisma/client";

import { CURRENT_MODEL_NAME, addTagsToEvent } from "./llm/eventToTags.js";

export default async function addTagsToEvents(lookbackDays: number = 30) {
  const prisma = new PrismaClient();

  try {
    const since = new Date();
    since.setDate(new Date().getDate() - lookbackDays);
    console.log(since);
    const events = await prisma.event.findMany({
      where: {
        date: { gte: since },
        OR: [
          { tagsProcessedBy: { not: { equals: CURRENT_MODEL_NAME } } },
          { tagsProcessedBy: { equals: null } }
        ]
      }
    });
    console.log(`Need to tag ${events.length} events`);
    await Promise.allSettled(
      events.map((event) =>
        (async () => {
          await prisma.event.update({
            where: { id: event.id },
            data: { tagsProcessedBy: CURRENT_MODEL_NAME + "_PROCESSING" }
          });

          const tags = await addTagsToEvent(event);
          console.log(`Event "${event.title}$ has tags: ${tags}`);

          for (const tag of tags) {
            await prisma.event.update({
              where: { id: event.id },
              data: {
                tags: {
                  connectOrCreate: {
                    where: { name: tag },
                    create: {
                      name: tag,
                      color: "",
                      icon: "",
                      category: ""
                    }
                  }
                }
              }
            });
          }

          await prisma.event.update({
            where: { id: event.id },
            data: { tagsProcessedBy: CURRENT_MODEL_NAME }
          });
        })()
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}
