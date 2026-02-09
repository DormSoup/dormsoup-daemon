import { extractFromEmail } from "../llm/emailToEvents";
import { simpleParser } from "mailparser";
import { readFile } from "fs/promises";
import { removeArtifacts } from "../llm/utils";
import { convert } from "html-to-text";
import { expect, test} from 'vitest';

async function readEmlFile(path: string) {
    const contents = await readFile(path);
    const parsed = await simpleParser(contents)
    const text = removeArtifacts(parsed.text ?? (parsed.html ? convert(parsed.html) : ""));
    parsed.text = text;
    return parsed;
}

test('extract email', async () => {
    const email = await readEmlFile("src/tests/emails/test.eml")
    const resp = await extractFromEmail(email.subject!, email.text!, email.date!);
    expect(resp.status).eq("admitted")
})