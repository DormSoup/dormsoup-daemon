import {
  AuthorizationCodeRequest,
  AuthorizationUrlRequest,
  CryptoProvider,
  PublicClientApplication
} from "@azure/msal-node";
import {
  DataProtectionScope,
  IPersistenceConfiguration,
  PersistenceCachePlugin,
  PersistenceCreator
} from "@azure/msal-node-extensions";
import express from "express";
import asyncHandler from "express-async-handler";
import fs from "fs";
import HttpStatus from "http-status-codes";
import https from "https";

type AuthResult = { user: string; accessToken: string; expiresOn: number };

export async function authenticate(): Promise<AuthResult> {
  const cachePath = ".token.json";
  const persistentConfig: IPersistenceConfiguration = {
    cachePath,
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: "hakken",
    accountName: "ubuntu",
    usePlaintextFileOnLinux: true
  };
  const persistence = await PersistenceCreator.createPersistence(persistentConfig);

  const clientConfig = {
    auth: {
      // Shamelessly pillaged from Thunderbird.
      // See https://hg.mozilla.org/releases/comm-esr102/file/tip/mailnews/base/src/OAuth2Providers.jsm
      clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
      authority: "https://login.microsoftonline.com/common"
    },
    cache: {
      cachePlugin: new PersistenceCachePlugin(persistence)
    }
  };
  const pca = new PublicClientApplication(clientConfig);
  const scopes = ["https://outlook.office.com/IMAP.AccessAsUser.All"];

  try {
    const accounts = await pca.getAllAccounts();
    if (accounts.length > 0) {
      console.log("Attempting to acquire token silently for user", accounts[0].username);
      const response = await pca.acquireTokenSilent({
        account: accounts[0],
        scopes
      });
      if (response !== null) {
        console.log("Acquired token silently for user", accounts[0].username);
        return {
          user: response.account!.username,
          accessToken: response.accessToken,
          expiresOn: response.expiresOn!.getTime()
        };
      }
    }
  } catch {}
  console.log("No cache or silent flow failed. Starting interactive flow...");

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
    pca.getAuthCodeUrl(authCodeRequest).then((response) => {
      console.log(response);
    })
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
        console.log("Successfully authenticated");
        const result: AuthResult = {
          user: response.account!.username,
          accessToken: response.accessToken,
          expiresOn: response.expiresOn!.getTime()
        };
        resolve(result);
      });
    })
  );
  const server = https.createServer({ key: privateKey, cert: publicKey }, app).listen(4443);
  return promise;
}
