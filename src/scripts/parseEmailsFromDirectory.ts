/// Parse an email from standard input, thus avoiding to authenticate to Outlook/Office365

// import { addTagsToEvent } from "../llm/eventToTags";
import { generateEventTags } from "../llm/eventToTags";
import { debugEmailToEvents, eventFromEmailFile } from "./utils";
import fs from 'node:fs';

/**
 * Parses all `.eml` email files from a specified directory and processes each file using `eventFromEmailFile`.
 *
 * The directory path is determined from the command-line arguments. If the script is run with Node.js,
 * it expects the directory path as the second argument (`process.argv[2]`). 
 * Otherwise, it uses the first argument (`process.argv[1]`).
 *
 * If the directory is not provided or does not exist, the function logs an error message and exits the process.
 * For each `.eml` file found in the directory, the function logs the file being parsed and calls `eventFromEmailFile` asynchronously.
 *
 * @returns {Promise<void>} A promise that resolves when all `.eml` files have been processed.
 */
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

await main();