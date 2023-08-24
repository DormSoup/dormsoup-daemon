import fetchEmailsAndExtractEvents from "./emailToEvents.js";
import addTagsToEvents from "./eventToTags.js";
import { flushEmbeddings, loadEmbeddings } from "./vectordb.js";

export default async function main() {
  await loadEmbeddings();

  while (true) {
    const lookbackDays = 150;
    console.log(`[${new Date().toISOString()}] Start pulling and parsing emails:`);
    const oldLog = console.log;
    console.log = (...args) => oldLog("  ", ...args);
    await fetchEmailsAndExtractEvents(lookbackDays);
    await addTagsToEvents(lookbackDays);
    await flushEmbeddings();
    console.log = oldLog;
    await new Promise((resolve) => setTimeout(resolve, 1000 * 60));
  }
}

await main();
