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
import { Deferred } from "./deferred";

type AuthResult = { user: string; accessToken: string; expiresOn: number };

/**
 * Attempts to silently acquire an authentication token for the first available account using the provided PublicClientApplication instance.
 *
 * @param pca - The PublicClientApplication instance used to interact with the authentication provider.
 * @param scopes - An array of scopes for which the token is requested.
 * @returns A promise that resolves to an `AuthResult` object containing the user's username, 
 * access token, and expiration time if successful, or `undefined` 
 * if no account is available or the token could not be acquired silently.
 */
async function trySlientAcquire(pca: PublicClientApplication, scopes: string[]): Promise<AuthResult|undefined> {
  try {
    const accounts = await pca.getAllAccounts();
    if (accounts.length > 0) {
      // "Attempting to acquire token silently for user
      const response = await pca.acquireTokenSilent({
        account: accounts[0],
        scopes
      });
      if (response !== null) {
        // Acquired token silently for user
        return {
          user: response.account!.username,
          accessToken: response.accessToken,
          expiresOn: response.expiresOn!.getTime()
        };
      }
    }
  } catch {}

    return undefined;
}

/**
 * Authenticates the user using Microsoft OAuth2 with token caching and PKCE.
 *
 * This function attempts to acquire an authentication token using a cached token if available,
 * or via a silent flow. If neither is possible, it initiates an interactive authentication flow
 * using a local HTTPS server and PKCE (Proof Key for Code Exchange).
 *
 * The function:
 * - Sets up a persistent token cache.
 * - Tries to acquire a token silently.
 * - If silent authentication fails, starts an interactive OAuth2 flow.
 * - Launches a local HTTPS server to handle the OAuth2 redirect and token exchange.
 * - Returns the authenticated user's information and access token.
 *
 * @returns {Promise<AuthResult>} A promise that resolves to the authentication result, including user info and access token.
 * @throws Will throw if authentication fails or if there are issues with the local HTTPS server.
 */
export async function authenticate(): Promise<AuthResult> {
  // token cache set up
  const cachePath = ".token.json"; // where to store cached auth token
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
  const scopes = [
    "https://outlook.office.com/IMAP.AccessAsUser.All",
    "https://outlook.office.com/POP.AccessAsUser.All",
    "https://outlook.office.com/SMTP.Send",
    // "offline_access"
  ];

  const slientAuthResult = await trySlientAcquire(pca, scopes)
  if (slientAuthResult !== undefined){
    return slientAuthResult;
  }

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

  const deferred = new Deferred<AuthResult>();

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
          deferred.reject(error);
          return;
        }
        console.log("Successfully authenticated");
        const result: AuthResult = {
          user: response.account!.username,
          accessToken: response.accessToken,
          expiresOn: response.expiresOn!.getTime()
        };
        deferred.resolve(result);
      });
    })
  );
  const server = https.createServer({ key: privateKey, cert: publicKey }, app).listen(4443);
  return deferred.promise;
}
