/// Parse an email from standard input, thus avoiding to authenticate to Outlook/Office365

// import { addTagsToEvent } from "../llm/eventToTags";
import { debugEmailToEvents } from "./utils";
import fs from 'node:fs';

// TODO: Comment this
async function main(): Promise<void> {
    let filename: string;
    // just in case
    if (process.argv[0].includes("node")) {
        filename = process.argv[2];
    } else {
        filename = process.argv[1];
    }
    if (filename === undefined) {
        console.error("Usage: npm run parseEmailFromFile filename")
        console.error("filename may be the path to an .eml file, or it may be - to read from standard input")
        process.exit(1);
    }
    const file = filename === "-" ? process.stdin.fd : filename;
    const contents = fs.readFileSync(file);
    const events = await debugEmailToEvents(contents);
    console.log("Done parsing event date/time!");
    
    console.log("Parsing tags from file is a working progress...") //:D")
    for (const event of events) {
        // TODO: fix this.
        // This doesn't actually work because Event from eventToTags.ts is a prisma type
        //   but Event from emailToEvents.ts is a custom typescript type
        //   and they have different fields, so the output of one cannot simply be used as
        //   input of the other, and having to query the database to debugging the tagging
        //   is annoying and should be unnecessary since this should be testable without need of
        //   a database...

        // console.log(await addTagsToEvent(event));
    }
}

await main();