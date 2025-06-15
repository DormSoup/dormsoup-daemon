/// Parse an email from standard input, thus avoiding to authenticate to Outlook/Office365

// import { addTagsToEvent } from "../llm/eventToTags";
import { generateEventTags } from "../llm/eventToTags";
import { debugEmailToEvents, debugGenerateTags, eventFromEmailFile } from "./utils";
import fs from 'node:fs';

/**
 * Parses an email file specified by the command line argument, extracts events, and generates tags for each event.
 *
 * The function determines the filename from the command line arguments. If the filename is "-", it reads from standard input.
 * It reads the file contents, parses the email to extract events, and then generates tags for each event, logging the results.
 *
 * Usage:
 *   npm run parseEmailFromFile <filename>
 *   - <filename> can be a path to an .eml file or "-" to read from standard input.
 *
 * @returns {Promise<void>} A promise that resolves when the operation is complete.
 */
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
    await eventFromEmailFile(file);
}

await main();