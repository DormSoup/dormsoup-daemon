import {
    AuthorizationCodeRequest,
    AuthorizationUrlRequest,
    CryptoProvider,
    PublicClientApplication
} from "@azure/msal-node";
import assert from "assert";
import express from "express";
import asyncHandler from "express-async-handler";
import fs from "fs";
import HttpStatus from "http-status-codes";
import https from "https";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import open from "open";

type AuthResult = { user: string; accessToken: string; expiresOn: number };

async function authenticate(): Promise<AuthResult> {
    const cacheFile = ".token.json";
    try {
        const cached = JSON.parse((await fs.promises.readFile(cacheFile)).toString()) as AuthResult;
        const current = new Date().getTime();
        if (current < cached.expiresOn) return cached;
    } catch {}

    const clientConfig = {
        auth: {
            // Shamelessly pillaged from Thunderbird.
            // See https://hg.mozilla.org/releases/comm-esr102/file/tip/mailnews/base/src/OAuth2Providers.jsm
            clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
            authority: "https://login.microsoftonline.com/common"
        }
    };
    const pca = new PublicClientApplication(clientConfig);
    const scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All"];
    const redirectUri = `https://localhost`;
    const cryptoProvider = new CryptoProvider();
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

    const authCodeRequest: AuthorizationUrlRequest = {
        scopes,
        redirectUri,
        codeChallenge: challenge,
        codeChallengeMethod: "S256"
    };

    let reject: (reason: any) => void;
    let resolve: (value: AuthResult | Promise<AuthResult>) => void;
    const promise = new Promise<AuthResult>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    const [privateKey, publicKey, _] = await Promise.all([
        fs.promises.readFile("selfsigned.key", "utf8"),
        fs.promises.readFile("selfsigned.crt", "utf8"),
        pca.getAuthCodeUrl(authCodeRequest).then((response) => open(response))
    ]);

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get(
        "/",
        asyncHandler(async (req, res) => {
            const tokenRequest: AuthorizationCodeRequest = {
                code: req.query.code as string,
                scopes,
                redirectUri,
                codeVerifier: verifier,
                clientInfo: req.query.client_info as string
            };
            const response = await pca.acquireTokenByCode(tokenRequest);
            res.status(HttpStatus.OK).type("text").send(response.accessToken);
            server.close((error) => {
                if (error !== undefined) {
                    reject(error);
                    return;
                }
                console.log("Successfully authenticated with token", response.accessToken);
                const result: AuthResult = {
                    user: response.account!.username,
                    accessToken: response.accessToken,
                    expiresOn: response.expiresOn!.getTime()
                };
                fs.promises
                    .writeFile(cacheFile, JSON.stringify(result))
                    .then(() => resolve(result))
                    .catch(reject);
            });
        })
    );
    const server = https.createServer({ key: privateKey, cert: publicKey }, app).listen(443);
    return promise;
}

export default async function main() {
    const client = new ImapFlow({
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        auth: await authenticate(),
        logger: false
    });

    await client.connect();

    let lock = await client.getMailboxLock("INBOX");
    try {
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        const since = new Date();
        since.setDate(new Date().getDate() - 30);
        const uids = await client.search({ sentSince: since }, { uid: true });
        console.log(`Received ${uids.length} mails in the past 30 days`);
        // See https://how-to-dormspam.mit.edu/.
        const dormspamKeywords = [
            "bcc'd to all dorms",
            "bcc's to all dorms",
            "bcc'd to dorms",
            "bcc'ed dorms",
            "bcc'ed to dorms",
            "bcc to dorms",
            "bcc'd to everyone",
            "bcc dormlists",
            "bcc to dormlists",
            "for bc-talk"
        ];
        for await (let message of client.fetch(
            uids,
            {
                uid: true,
                envelope: true,
                source: true
            },
            { uid: true, changedSince: 0n }
        )) {
            const parsed = await simpleParser(message.source, { skipImageLinks: true });
            if (dormspamKeywords.some((keyword) => parsed.text?.includes(keyword))) {
                console.log(`${message.uid}: ${message.envelope.subject}`);
            }
        }
    } finally {
        lock.release();
    }
    await client.logout();
}

await main();