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

type AuthResult = { user: string; accessToken: string };

async function authenticate(): Promise<AuthResult> {
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
    pca.getAuthCodeUrl(authCodeRequest)
        .then((response) => {
            console.log(response);
        })
        .catch((error) => console.log(JSON.stringify(error)));
    const app = express();
    let resolve: (value: AuthResult | Promise<AuthResult>) => void;
    const promise = new Promise<AuthResult>((res) => (resolve = res));
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
            res.status(HttpStatus.OK).send(response.accessToken);
            console.log(response.accessToken);
            server.close(() => {
                resolve({ user: response.account!.username, accessToken: response.accessToken });
            });
        })
    );
    const [privateKey, publicKey] = await Promise.all([
        fs.promises.readFile("selfsigned.key", "utf8"),
        fs.promises.readFile("selfsigned.crt", "utf8")
    ]);
    const server = https.createServer({ key: privateKey, cert: publicKey }, app);
    server.listen(443);
    return promise;
}

export default async function main() {
    const client = new ImapFlow({
        host: "outlook.office365.com",
        port: 993,
        secure: true,
        auth: await authenticate()
    });

    // Wait until client connects and authorizes
    await client.connect();

    // Select and lock a mailbox. Throws if mailbox does not exist
    let lock = await client.getMailboxLock("INBOX");
    try {
        // fetch latest message source
        // client.mailbox includes information about currently selected mailbox
        // "exists" value is also the largest sequence number available in the mailbox
        assert(typeof client.mailbox !== "boolean");
        console.log(`Mailbox has ${client.mailbox.exists} messages`);
        let message = await client.fetchOne(`${client.mailbox.exists}`, { source: true });
        console.log(message.source.toString());

        // list subjects for all messages
        // uid value is always included in FETCH response, envelope strings are in unicode.
        for await (let message of client.fetch("1:*", { envelope: true })) {
            console.log(`${message.uid}: ${message.envelope.subject}`);
        }
    } finally {
        // Make sure lock is released, otherwise next `getMailboxLock()` never returns
        lock.release();
    }

    // log out and close connection
    await client.logout();
}

main();
