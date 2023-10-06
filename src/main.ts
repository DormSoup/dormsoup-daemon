import fetchEmailsAndExtractEvents from "./emailToEvents.js";
import addTagsToEvents from "./eventToTags.js";
import { pushToSubscribers } from "./subscription.js";
import { flushEmbeddings, loadEmbeddings } from "./vectordb.js";

export default async function main() {
  await loadEmbeddings();

  while (true) {
    const lookbackDays = 30;
    console.log(`[${new Date().toISOString()}] Start pulling and parsing emails:`);
    console.group();
    await fetchEmailsAndExtractEvents(lookbackDays);
    await flushEmbeddings();
    await addTagsToEvents(lookbackDays);
    await flushEmbeddings();
    await pushToSubscribers();
    await flushEmbeddings();
    console.groupEnd();
    await new Promise((resolve) => setTimeout(resolve, 1000 * 60));
  }
}

await main();
