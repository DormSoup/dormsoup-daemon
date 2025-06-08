/// Parse an email from standard input, thus avoiding to authenticate to Outlook/Office365

// import { addTagsToEvent } from "../llm/eventToTags";
import { debugEmailToEvents } from "./utils";
import fs from 'node:fs';

async function main(): Promise<void> {
    let directory: string;
    // just in case
    if (process.argv[0].includes("node")) {
        directory = process.argv[2];
    } else {
        directory = process.argv[1];
    }
    if (directory === undefined) {
        console.error("Usage: npm run parseEmailFromFile directory")
        console.error("directory may be the path to a directory with .eml files")
        process.exit(1);
    }
    if (!fs.existsSync(directory)) {
        console.error(`Directory not found: ${directory}`);
        process.exit(1);
    }

    const fileNames = fs.readdirSync(directory).filter(file => file.endsWith('.eml'));
    for (const file of fileNames) {
        const filePath = `${directory}/${file}`;
        console.log(`Parsing ${filePath.slice(0, -4)}...\n`)
        await eventFromEmailFile(filePath);
        console.log("\n")
    }
}

async function eventFromEmailFile(file: string){
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