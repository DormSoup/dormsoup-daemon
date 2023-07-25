import { PrismaClient } from "@prisma/client";

import { createEmbedding, removeArtifacts } from "../llm/utils.js";
import {
  flushEmbeddings,
  getDistance,
  getEmbedding,
  getKNearestNeighbors,
  insertEmbedding,
  loadEmbeddings
} from "../vectordb.js";

export async function main() {
  const prisma = new PrismaClient();
  await loadEmbeddings();
  await prisma.$connect();
  try {
    const events = await prisma.event.findMany({
      select: {
        id: true,
        title: true,
        date: true,
        location: true,
        fromEmail: { select: { receivedAt: true } }
      }
    });

    await Promise.all(
      events.map(({ id, title }) =>
        (async () => {
          if (getEmbedding(title) !== undefined) return;
          const embedding = await createEmbedding(title);
          const existingEntry = getEmbedding(title);
          console.log("Fetched embedding for", title);
          if (existingEntry !== undefined) existingEntry.metadata.eventIds.push(id);
          else insertEmbedding(title, embedding, { eventIds: [id] });
        })()
      )
    );
    console.log("Done fetching embeddings");

    const idToEvents = new Map<number, (typeof events)[0]>();
    for (const event of events) idToEvents.set(event.id, event);

    function mergeEvents(event1: (typeof events)[0], event2: (typeof events)[0]) {
      const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
      const sameDate =
        ((isAllDay(event1.date) || isAllDay(event2.date)) &&
          event1.date.getDay() === event2.date.getDay()) ||
        event1.date.getTime() === event2.date.getTime();
      if (!sameDate) return undefined;
      const sameLocation =
        event1.location.toLowerCase() === "unknown" ||
        event2.location.toLowerCase() === "unknown" ||
        event1.location.toLowerCase().includes(event2.location.toLowerCase()) ||
        event2.location.toLowerCase().includes(event1.location.toLowerCase());
      if (!sameLocation) return undefined;
      return event1.fromEmail!.receivedAt <= event2.fromEmail!.receivedAt ? event1 : event2;
    }

    const mergedEventIds = new Map<number, number>();

    for (const event of events) mergedEventIds.set(event.id, event.id);

    const getRoot = (id: number) => {
      let root = id;
      while (mergedEventIds.get(root) !== root) root = mergedEventIds.get(root)!;
      return root;
    };

    for (const event of events) {
      const knn = getKNearestNeighbors(getEmbedding(event.title)!.embeddings, 3);
      for (const [title, distance] of knn) {
        const {
          metadata: { eventIds }
        } = getEmbedding(title)!;
        for (const eventId of eventIds) {
          if (eventId === event.id) continue;
          const rootA = getRoot(event.id);
          const rootB = getRoot(eventId);
          const merged = mergeEvents(idToEvents.get(rootA)!, idToEvents.get(rootB)!);
          if (merged === undefined) continue;
          if (merged.id === rootA) mergedEventIds.set(rootB, merged.id);
          if (merged.id === rootB) mergedEventIds.set(rootA, merged.id);
        }
      }
    }

    for (const event of events) {
      if (getRoot(event.id) !== event.id) {
        const from = idToEvents.get(event.id)!;
        const to = idToEvents.get(getRoot(event.id))!;
        console.log(
          `Merging event "${event.title}" into event "${
            idToEvents.get(getRoot(event.id))!.title
          }":`,
          getDistance(getEmbedding(from.title)!.embeddings, getEmbedding(to.title)!.embeddings)
        );
        // await prisma.event.delete({ where: { id: event.id } });
      }
    }

    // const allEvents = await prisma.event.findMany({
    //   select: { id: true, title: true, text: true }
    // });
    // for (const event of allEvents) {
    //   if (event.text.length > 100000) {
    //     console.log(`Event "${event.title} has absurdly long text (${event.text.length})`);
    //     const removed = removeArtifacts(event.text);
    //     if (removed.length < 100000) {
    //       await prisma.event.update({ where: { id: event.id }, data: { text: removed } });
    //       console.log("  fixed by removing artifacts");
    //     } else {
    //       console.log("  still very long after removal: ", removed);
    //     }
    //   }
    //   // await prisma.event.update({
    //   //   where: { id: event.id },
    //   //   data: { text: removeArtifacts(event.text) }
    //   // });
    // }
  } finally {
    await flushEmbeddings();
    await prisma.$disconnect();
  }
}

await main();
