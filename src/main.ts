import fetchEmailsAndExtractEvents from "./emailToEvents.js";
import addTagsToEvents from "./eventToTags.js";

export default async function main() {
  // await fetchEmailsAndExtractEvents();  
  await addTagsToEvents();
}

await main();